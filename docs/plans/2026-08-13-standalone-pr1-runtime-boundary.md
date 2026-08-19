# 实施计划：Standalone PR1 —— Conversations runtime ownership 与隔离边界

日期：2026-08-15

上游设计：`docs/design/standalone-daemon-sessions.md`

关联：Issue #8908、PR0 #8890

发布基线：`origin/main` at `9aa570446aa590442e835e8a9cf501d3fe4da3e9`

PR0 已合入：#8890，squash merge commit `c9cb53398dcf7faa9e70a30f7f38b5946cf2def1`，最终 PR head `9d08762121df9918095d08baf2295f43415fe32a`

## Goal

在 PR0 的 `ConversationRuntimeManager` 与 owned-runtime publication 基础上，完成两个隐藏基础能力：

1. 同一用户的多个 supporting daemon 中，最多一个进程持有 Conversations runtime；有效外部 owner、被篡改的 owner 状态和根目录失败均返回结构化错误，且绝不回退 primary runtime。
2. `live-conversation` runtime继续服务owner-routed session、Live、health/capabilities、user-global config reconciliation，以及既有Live只读channel与scheduled-task管理的窄兼容面；除此之外，所有普通workspace选择器、管理路由和非全局配置的后台workspace fanout默认看不到它。

PR1 不增加 standalone source、公开 standalone routes、SDK/standalone UI 行为或 `standalone_sessions_v1` capability；WebShell只做两类兼容收口：既有`kind: "live"` entry的ordinary selector/presentation guard（新会话、scheduled-task、workspace voice与scratch outcome列表），以及Live Sidebar catalog的capability-gated `sourceType=default`过滤。

## Baseline 与开工门槛

- PR1 不再是 stacked PR；设计分支已直接基于包含 PR0 merge commit 的最新 `origin/main`。不得重放或 rebase 到旧 PR0 head，否则会与 squash merge 重复。
- 实现分支已在发布前将 PR1 自身提交 rebase 到 `9aa570446aa590442e835e8a9cf501d3fe4da3e9`；不重放旧 PR0 head，避免与 squash merge 重复。
- 发布基线已包含 PR0 后续的 telemetry、background-shell active-work、cross-worktree Git guard 以及 WebShell 更新。PR1 按该基线的 handler-resolved/pre-resolved attribution contract 验证 telemetry 隔离，并让既有 bridge/session drain（包括其后台 shell）先于 owner release 完成。
- 当前inventory用`rg`得到49个import或访问`WorkspaceRegistry`/`WorkspaceRuntime`的production TypeScript文件：43个直接选择/registry consumer，加6个只接收已选runtime或generation guard的helper；下文均已分类。这是实现门禁，不是一次性文档。实现开始和每次同步main后都要重建，尤其复核`server.ts`、`run-qwen-serve.ts`、`routes/session.ts`、`acp-http/index.ts`、Channel/Goal/multi-agent路径。
- 最终 PR0 的 owned publication 只有 registry add 前的 `validateBeforePublication`；它不会先发布一个 non-routable entry 再 rollback。PR1 必须在这个 pre-publication seam 内完成 candidate 与 exact-root 重验，不引入第二个 publication state machine。

## Invariants

- Owner record 位于真实user-home下的稳定runtime目录，不受`QWEN_HOME`、`QWEN_RUNTIME_DIR`、project workspace或project settings影响；两个不同`QWEN_HOME`但共享同一OS home/Conversations root的daemon仍必须竞争同一record。
- 一个进程身份是 `{ pid, instanceNonce }`；相同 PID、不同 nonce 按 PID reuse/foreign owner 处理并 fail closed。
- 只有有效且已死亡的 foreign owner 可以被替换；替换后等待固定的短 drain grace，再允许 publish/use runtime。
- malformed、symlink、wrong owner、wrong mode、oversize 或无法证明安全的 record 均不删除、不覆盖。
- release 只删除仍匹配当前 `{ pid, instanceNonce }` 的 record，并且只能发生在 route/session/bridge/child drain 完成且 listener close callback 已确认之后。
- force-exit、drain error、channel-worker retry或listener secondary deadline均不进入owner unlink。release在exact unlink前失败时本进程不删除/覆盖观测状态，匹配record若仍存在则保留；missing/foreign/invalid保持原样并报compromise。若exact unlink已成功但lock cleanup失败，record已安全移除且进程内claim必须清除，`close()`仍报错并让后继通过lock recovery而非假装完整handoff。
- 除下述source/session identity验证过的兼容catalog与精确session操作外，普通workspace selector无论使用workspace ID、原始cwd、canonical cwd或path alias，都把internal runtime当成不存在。
- 任何internal lookup failure都不能改选primary；owner-routed lookup要么得到已验证的internal owner，要么返回错误。session owner index若指向transitioning/draining/blocked internal entry，必须保留该index并返回明确unavailable outcome，不能跳过后扫描active primary；只有active runtime明确报告session不存在或entry真正removed时才按既有契约清除stale index。
- ordinary request的mismatch/conflict/admission error不返回internal workspace ID/cwd，也不把internal计入workspace count；capabilities的临时`kind: "live"` entry和已授权session结果是明确兼容例外。
- Registry 仍保存完整 runtime 集合，供 shutdown、总 session-ID admission、session owner index、Live 和观测聚合使用；隔离发生在 resolver 和每个 direct consumer 边界，不改变 registry 的底层语义。
- `GET /capabilities` 可暂时保留 `{ kind: "live" }` 兼容 entry，但不得新增 standalone capability；普通路由即使拿到该 ID 也必须拒绝。
- `createServeApp` direct embed只有在把实际接收请求的Node listener绑定到共享lifecycle后才能claim/publish Conversations；未绑定时ordinary routes保持可用，任何internal boot/ensure都fail closed且不执行ownership I/O。绑定后的listener close、app-local drain、host drain与owner release必须由同一个lifecycle串行证明，不能让embed和`runQwenServe`各维护一套释放状态。

## Ownership contract

### Stable record

新增 `packages/cli/src/serve/conversations/conversation-runtime-ownership.ts`，默认 record 为：

```text
~/.qwen/conversations/runtime-owner.json
```

最小且exact（unknown key也拒绝）schema：

```ts
interface ConversationRuntimeOwnerRecord {
  version: 1;
  pid: number;
  instanceNonce: string;
}
```

不写 URL、token、workspace path 或可由 project 配置覆盖的值。PID必须是正safe integer，nonce沿用Live的UUID/pattern约束。POSIX敏感叶目录（owner record目录与Live locator目录）为 owner-only `0700`，record 为 link count 1的regular non-symlink owner-only `0600`；Windows只承诺regular non-reparse、single-link、canonical identity与既有平台可观测的path安全，不虚构uid/mode/ACL保证。读取有固定 byte 上限。首次创建目录时，先 canonicalize并记录nearest existing ancestor，再逐级使用non-recursive `mkdir`创建缺失组件；每一级在`mkdir`/`EEXIST`后都重验parent和child identity，拒绝symlink、非目录或竞态替换。既有祖先只要求稳定的canonical identity及POSIX same-owner，不把`0700`追溯强加给历史`~/.qwen`；敏感叶目录必须满足上述严格权限。只有本次成功创建的组件可依创建mode设置权限；既有unsafe敏感叶目录不得靠recursive `mkdir`或`chmod`静默修复。`proper-lockfile` 必须显式把 `lockfilePath` 放在已验证目录内（例如 `.runtime-owner.lock`），不能使用默认的 sibling `~/.qwen/conversations.lock`。进入 lock 前记录目录的 canonical/device/inode identity，lock 后及每次 read/rename/unlink 前重验，目录替换或 symlink一律 compromised。record读取采用 `lstat -> open(no-follow where supported) -> fstat`，并要求 path/handle device+inode一致；不得在 `lstat(path)` 后直接 `readFile(path)`。写入采用 same-directory `wx` temp file、`sync`与最终安全校验；POSIX可rename-over exact validated target，Windows在lock内重验后采用平台支持的commit顺序，不声称目标已存在时仍有不可实现的atomic overwrite。Windows删除validated dead target前必须已sync current temp；若删除后current commit失败，活进程保持owner lock并完成一次不可取消grace后才release/throw，进程崩溃则由大于grace加最大临界区的stale阈值保证后继恢复锁时已跨过grace。该异常gap路径不启动runtime。只best-effort清理当前operation持有的随机temp；crash遗留和其他未知文件均忽略且不删除。

lock使用显式、可测试的bounded retry window覆盖正常I/O临界区；一个仍有效的foreign lock只是暂时busy，耗尽重试映射为`conversation_runtime_unavailable`，不能误报篡改。unsafe lock shape、stale-lock recovery失败、`ECOMPROMISED`或release ownership丢失才映射为`conversation_runtime_ownership_compromised`。显式`onCompromised`只记录并唤醒当前operation；每次commit/release前检查该状态，不使用library默认的异步throw handler把进程直接crash。stale阈值必须大于handoff grace加最大正常文件临界区，update间隔满足library约束，两者均可测试注入。

Ownership constructor必须是无 I/O、无 timer、无 process handler的纯构造。其 `stableBaseDir` 与 Live discovery 使用同一个已解析值：production沿用`getStableLiveDiscoveryBaseDir()`语义固定为真实home下的`~/.qwen`，不得改用会跟随`QWEN_HOME`的`Storage.getGlobalQwenDir()`；`runQwenServe` 的 `liveDiscoveryStableBaseDir` test/embed override必须同时传给 ownership和locator，不能出现两套“stable”目录。`proper-lockfile` 与 legacy `live/discovery` inspection在首次 `acquire()` 内动态加载；manager只 type-import ownership contract。这样不会破坏现有 serve startup import boundary，也不会因为 Live关闭而提前加载或创建稳定目录。

`runQwenServe`只解析一次stable base并传给app与locator。`createServeApp`在`LiveHostCoordinator`产生nonce后，通过窄factory seam `(pid, instanceNonce, stableBaseDir) => ConversationRuntimeOwnership`构造side-effect-free实例，保证默认production ownership与tests注入的fake都拿到同一identity；再把同一实例装配到manager、Live discovery gate与`app.locals`。默认factory的构造仍无I/O，真实home下的目录/record只有在下述listener binding已经成立且internal boot实际开始后才会访问。

`createServeApp(): Application`保持返回类型兼容，但在app上安装一个共享、one-flight的`ServeAppLifecycle`，并从`serve/index.ts`导出类型与`getServeAppLifecycle(app)` accessor：

```ts
interface ServeAppLifecycle {
  bindServer(
    server: Server,
    options?: {
      startupReady?: Promise<void>;
      drainHost?: () => Promise<void>;
    },
  ): void;
  close(options?: { timeoutMs?: number }): Promise<void>;
}
```

`bindServer`必须在第一次`server.listen()`和任何internal boot attempt前，把实际接收该app请求的尚未listening Node `Server`绑定exactly once；已listening server、重复绑定、绑定不同server或boot开始后的迟到绑定都明确拒绝。这样不会存在listener已经接收请求、lifecycle却尚未拥有cleanup proof的窗口。lifecycle监听绑定后的真实`listening`/`error`/`close`结果：direct embed在listener成功后即可打开其boot admission，且首次pre-listen error直接seal/reject；`runQwenServe`则额外传入覆盖完整host startup的`startupReady` promise，只有listener与该promise都成功才打开。production的listen retry classifier仍由`runQwenServe`拥有，transient `EADDRINUSE`只尝试同一pre-bound server的下一个port，不reject `startupReady`、不调用`server.close()`、也不被lifecycle误判为shutdown；只有所有listen尝试或后续channel/runtime startup最终失败时才reject该promise并seal。为满足exactly-once binding，HTTP路径也改为先`http.createServer(app)`，与现有HTTPS路径一样在首个listen attempt前绑定并跨port retry复用同一对象，不再让每次`app.listen()`隐式创建新server。

`drainHost`是唯一的外层lifecycle seam，在close开始时与app-local seal一起发起，并在owner release前等待；`runQwenServe`用它纳入channel worker、process registry及其他不属于app的drain，direct embed通常省略。`RunHandle.close()`委托同一个handle，不再维护第二个ownership release gate。绑定后的embed即使直接调用`server.close()`，`close`事件也必须同步seal并启动同一条one-flight cleanup，错误保存在handle上；公开文档仍要求调用并await `lifecycle.close()`，以便在进程退出前等待drain/release并接收错误。未调用`bindServer`时ordinary app行为保持不变，explicit Live/internal请求返回结构化unavailable，capabilities返回ordinary snapshot，绝不能退成no-op ownership或写真实home。所有会触发internal route的direct-app tests都注入无外部资源fake并绑定真实ephemeral test listener；纯assembly测试可保持unbound并断言零ownership I/O。

boot hook等待共享lifecycle的boot-admission barrier：server必须已绑定并成功listening；`runQwenServe`还必须已经把app纳入同一cleanup owner，且其channel/runtime startup其余可失败门禁全部通过。direct embed的pre-listen error、production最终listen failure、`startupReady` rejection或shutdown均reject/seal barrier；production可重试listen error不改变barrier。`runQwenServe`遇到最终listen或host startup failure时，必须先调用并await同一个`ServeAppLifecycle.close()`，完成可证明的listener/app/host cleanup后才reject启动promise；若`drainHost`仍持有retryable worker/service lease，则沿既有runtime-failure retry语义保持cleanup owner，不能先把失败返回给一个已失去handle的caller。该路径尚未打开boot时ownership release是无I/O no-op。dedicated Live或internal catalog请求在production channel startup期间可等待barrier但不能抢先acquire。`/capabilities`是例外：channel worker在ready前会探测该route，因此barrier未open且boot未开始时必须立即返回不含internal entry的ordinary snapshot，既不等待也不触发claim；barrier open后若boot已经开始，后续capabilities才等待同一settlement并稳定反映结果。direct embed没有额外`startupReady`时仍必须先绑定并成功启动真实listener，不能靠test-only bypass伪造close proof。

装配阶段不得启动ownership I/O：当前`createServeApp`末段立即触发的Live runtime boot改成显式one-flight `startConversationRuntimeBoot()`。production `runQwenServe`只有在`createServeApp`成功返回、共享lifecycle已绑定server、listener成功启动，并且channel worker等其他会让runtime startup失败的门禁已通过后，才可在eager discovery publication/readiness之前主动调用；成功监听是必要但不充分条件，也不是让Live-disabled ordinary daemon无条件claim owner的新理由。所有同步listen throw、最终`error`/port retry失败和pre-runtime-ready startup failure都发生在claim之前。Live兼容面启用时的首个兼容Live catalog或dedicated Live请求可lazy触发并等待同一hook；capabilities只有在共享barrier已open后才能触发首次attempt，否则按上段返回ordinary snapshot。首次attempt settled后，capabilities只等待当前pending或读取snapshot，不因轮询重复acquire；后续显式Live/internal请求可新开attempt，允许loser在foreign owner退出后恢复。每个attempt仍one-flight并在settled后清除pending，terminal ownership compromise则由ownership对象固定拒绝。直接app测试必须使用前述显式fake ownership与bound ephemeral listener。只有在Live兼容面启用且selector精确命中configured Conversations ID/root、并且catalog显式携带`sourceType=default`时，session route才可在ordinary resolver前触发这个preflight；任意ID/cwd、无source catalog或普通workspace请求均不能因此claim owner。capabilities在boot已开始时继续等待settlement再取snapshot，成功时稳定看到active`kind: "live"`entry；ownership失败沿既有非广告语义不伪造entry，真正请求Live/internal操作时再返回structured error。`/live/start`与`/live/new`必须改为async handler，在调用同步coordinator action前await同一boot hook；该preflight的typed ownership/root/runtime error直接由Live route serializer转成`status/code/retryable`，不能被后台eager boot的catch吞掉后先返200。非HTTP Host action仍沿既有Live state/error channel报失败，不伪造HTTP响应。这样后续route assembly、listen或channel startup失败不会留下外层拿不到引用的active owner record，也不改变无Live/无standalone需求daemon的惰性。shutdown seal必须阻止尚未开始的boot，并等待已经开始的boot/ownership acquire/publish settled后再进入release gate。

公开给 manager/lifecycle 的窄接口：

```ts
interface ConversationRuntimeOwnership {
  acquire(): Promise<{ reclaimed: boolean }>;
  release(): Promise<boolean>;
}
```

内部状态最小化为`unclaimed → provisional → owned → released`并带不可清除的terminal-compromised flag：commit/确认current record后先进入`provisional`，只有所有lock cleanup成功且必要grace完成后才进入`owned`。任何post-commit、acquire成功前的错误把实例置为terminal provisional，并让该次及后续调用固定返回non-retryable ownership compromise；owned后观测到missing/foreign/invalid/unsafe也同样置terminal。terminal且尚未released时，`release()`拒绝unlink，即使外部后来把record恢复成相同nonce也不能洗掉compromise。这样provisional current record留给进程死亡后的后继重新执行grace，不能因旧locator已删除而跳过handoff。Windows destructive gap若current record从未commit，则在lock内完成grace后仍保持unclaimed，可按实际I/O错误重试，不属于provisional。

`release()`的boolean只表达“本调用是否删除了owned current record”：从未claim或成功release后的重复调用返回`false`且无I/O；provisional或terminal pre-unlink release抛structured compromise且不碰record；owned时record缺失、invalid或nonce/PID不匹配会先置terminal，再抛错并绝不删除。exact unlink一成功就转为`released`；随后lock cleanup成功则返回`true`，cleanup失败则抛structured compromise但重复release仍为无I/O `false`，因为record已经不存在，不能伪称仍由本实例claim。

`acquire()`使用进程内one-flight串行化并发调用，但每个新的acquire cycle都在锁内重读和校验record，不能仅依赖cached state。若本对象已经owned，只有record仍精确匹配当前PID/nonce才可幂等成功；missing、foreign、invalid或unsafe都表示运行中ownership proof被破坏，置terminal、映射non-retryable compromise且不重建/回收。in-flight `provisional`是正常中间态，所有caller等待同一promise；若acquire promise已settled而实例仍停在`provisional`，则必须同时带terminal flag，之后不能重试成owned。下表只描述unclaimed或精确same-owner的正常决策。正常成功路径在锁内完成legacy inspection与owner commit，确认locks release成功后才在锁外等待dead-owner drain grace；唯一例外是上述Windows destructive commit gap失败，它为防无record后继提前进入而在owner lock内等待grace后报错。grace仍属于同一个pending acquire，在完成前任何同进程caller都不能提前成功；另一个进程此时看到alive current owner或busy lock并fail closed。这样正常路径不为1秒等待持有filesystem lock，也不需要靠heartbeat维持grace。结果规则：

| 当前状态                         | 结果                                                                          |
| -------------------------------- | ----------------------------------------------------------------------------- |
| 无 record                        | 原子写入当前 owner，`reclaimed: false`                                        |
| 与当前 PID/nonce 相同            | 幂等成功，`reclaimed: false`                                                  |
| foreign valid record，PID alive  | `503 conversation_runtime_in_use`，`retryable: true`                          |
| foreign valid record，PID dead   | 按平台serialized commit，锁外等待1,000 ms injectable grace，`reclaimed: true` |
| PID 相同、nonce 不同             | 按 active foreign owner 处理，防 PID reuse                                    |
| unsafe/invalid/unreadable record | `503 conversation_runtime_ownership_compromised`，`retryable: false`          |

1,000 ms grace在dead Conversations owner或dead foreign legacy Live owner handoff后执行；同一次acquire若两者都stale也只等待一次，返回的`reclaimed`在任一handoff发生时为`true`。对校验通过且PID已死的foreign Live locator，在owner→Live锁序内先commit/确认当前owner record，再nonce/PID精确删除locator；两把lock都成功释放后才等待grace。commit后的grace是不可取消、只resolve的timer，shutdown等待同一个pending acquire，不能用AbortSignal让same-owner retry跳过未完成grace。无需额外的“已等待locator”journal/cache：成功acquire已完成grace；grace前进程退出或post-commit失败则provisional current record必须保留，后继会从dead owner record再次执行grace。测试通过注入`isProcessAlive`、只resolve的`wait`与base dir保持确定性，production使用`process.kill(pid, 0)`，除`ESRCH`外均视为alive。

### Legacy Live compatibility

复用`live/discovery.ts`已有的size/schema/mode/owner/PID校验，不复制第二套宽松parser；同时把其platform contract与owner record对齐：mode/uid仅在POSIX强制，Windows验证regular non-reparse/single-link与可观测identity。legacy locator目录不存在时inspection直接返回absent，不为检查而创建Live目录；目录存在时先验证regular non-reparse、canonical/device/inode和POSIX owner-only属性，再把explicit lock path放在该目录内，既有unsafe目录不靠`chmod`静默修复。后续Live publish若需首次创建目录，复用owner record的nearest-existing-ancestor、逐级non-recursive `mkdir`与identity revalidation契约，不能保留现有recursive `mkdir`/unconditional `chmod`旁路。新增一个locked handoff seam，返回owner状态并允许调用方在仍持有Live lock时对已验证dead record做exact nonce/PID removal：

- 无stable Live record或same `{pid, nonce}`：允许继续；dead foreign record在current owner commit后精确移除并触发一次drain grace；
- active foreign Live owner：映射为 `conversation_runtime_in_use`；
- malformed/unsafe stable Live record：映射为 `conversation_runtime_ownership_compromised`。

Conversation owner acquisition locked-inspect一次 legacy stable Live owner，再提交/确认新 owner record并完成必要 grace。不要增加无法闭合 mixed-version竞态的多阶段 handshake：旧版本在新 standalone owner 之后启动无法被强制遵守新 record，继续保留设计文档中的 mixed-version unsupported 限制。Live启用路径在 acquire后紧接着执行既有 nonce/PID-protected discovery write，因此仍会拒绝 acquisition期间已出现的 foreign Live owner。

只有真实home下的stable Live locator参与cross-daemon legacy arbitration；现有`runtimeBaseDir` locator可随`QWEN_HOME`改变，不能被当作user-global owner proof。但当stable与runtime base不同时，两个locator都必须等待同一boot成功才发布，shutdown也必须在owner release前对每个曾发布target取得“exact current owner removed”或“already absent”的正向证明。

一次Live publication只有在全部distinct target都写入当前PID/nonce后才进入ready；若后一个target失败，立即对本次已成功target做nonce/PID-protected compensating removal并保持not-ready/retry状态。cleanup成功的target可从published set移除；cleanup失败或结果不明的target必须保留到shutdown proof，不能因publish promise已失败而遗忘。该补偿不释放Conversation owner，也不把partial locator success当成endpoint ready。

唯一允许的嵌套顺序是owner lock→legacy Live inspection lock；任何持有Live lock的路径都不得再获取owner lock。`acquire()`返回前两者均已释放，Live publish随后单独获取Live lock；shutdown也先完成Live cleanup并释放其lock，再进入owner release。实现与测试断言没有Live→owner反向等待。

`LiveHostCoordinator.daemonInstanceNonce` 与 Conversations owner 使用同一 nonce。Live discovery publish 必须等待同一个Conversation boot成功：既已`acquire()`，又已revalidate/publish出active internal runtime，缺一都不写locator；这样启用Live但owner/root/runtime失败的daemon不会广告一个无权或无能力提供的endpoint。Live disable不提前release owner，owner生命周期仍是daemon lifetime。

### Structured errors

新增独立的 CLI-local `conversation-runtime-errors.ts`，只定义ownership与manager共用的typed error contract，避免manager为了错误类在startup期加载ownership实现。错误固定 `status = 503`、`code`、`retryable`，响应和用户可见日志均不暴露record/root path、nonce或foreign PID：

- `conversation_runtime_in_use`：`retryable: true`
- `conversation_runtime_ownership_compromised`：`retryable: false`
- `conversation_root_compromised`：`retryable: false`
- `conversation_runtime_unavailable`：`retryable: true`

Ownership typed errors原样传播。`ConversationWorkspace` identity/mode/owner/exact-root失败，Conversations exact root已被non-internal entry占用，或owned runtime违反`!primary`、`trusted`、`removable === false`、`live-conversation` provenance不变量，均映射为non-retryable `conversation_root_compromised`；pre-publication runtime construction/validation的可重试失败，以及已知internal entry处于transitioning/draining/blocked等暂时不可用状态，映射为`conversation_runtime_unavailable`。serializer不根据错误message猜类型；在抛出边界显式wrap并保留cause仅供内部日志，响应使用固定sanitized message。后续PR2/PR3直接复用该contract。

Live-enabled daemon的后台eager boot遇到ownership/root错误时保持现有降级边界：ordinary primary/secondary workspace服务可继续启动，但不发布internal runtime、`kind: "live"` entry或Live locator；首个真正请求Conversations/Live的操作返回上述structured error。不得把后台错误升级为整个ordinary daemon启动失败，也不得吞掉后再回退primary。

## Isolation contract

### Default-deny resolver

在 `workspace-registry.ts` 把 derived scope 固化到 `WorkspaceEntry`（例如 `internal: boolean`；replacement 不得改变该 scope），并增加两个最小 predicate：

```ts
isConversationRuntime(runtime): runtime.provenance === 'live-conversation'
isConversationEntry(entry): entry.internal
```

entry-level scope 是必需的：transitioning、draining 或 blocked entry 没有 active runtime，普通 resolver 仍必须把它识别为 internal，而不是从已关闭的 `current.runtime` 重新推断 scope 或泄露成 `workspace_runtime_unavailable`。`removed` entry 按当前 registry contract 会立即从ID/cwd index与list中删除，不需要虚构publication rollback状态。不要新增第二个 registry。`workspace-route-runtime.ts` 中面向普通 workspace 的 entry/runtime/path resolvers 默认过滤 internal runtime，包括 direct ID fast path、exact cwd、canonical scan 与 lexical fallback；`sendWorkspaceMismatch` 的 `workspaceCount` 只计算普通 workspace。

Owner-routed session 和 Live service 不调用这些 user-workspace resolvers，而是继续通过 session owner index、exact transcript ownership 或 `ConversationRuntimeManager` 明确 opt in。没有调用者需要一个“任意 internal path selector” helper；若实现过程中出现这种需求，应先证明它是 owner-routed，而不是添加通用逃生口。

窄compatibility resolver只能接受已知configured internal ID或exact root，并先读取固化entry scope：active/current才返回runtime；transitioning/draining/blocked返回typed`conversation_runtime_unavailable`，removed/unknown返回not-found或mismatch；任何分支都不回退primary。普通resolver对同一inactive internal仍按隐藏workspace处理，不泄露其存在。

现有WebShell会从capabilities的兼容`kind: "live"` entry发起Live catalog读取，并把返回session的internal cwd传给load/resume；PR1不能通过blanket deny破坏它。`routes/session.ts`因此只有以下窄例外，且不得复用为通用workspace resolver：

- singular/plural list GET仅在selector精确命中active internal entry、请求显式带现有projectless `sourceType=default`过滤时进入兼容catalog路径；返回结果仍按compatible Live/legacy projectless metadata过滤，不能只信query，也不能让未来`sourceType=standalone`提前穿透。pagination/filtering必须保留底层`nextCursor`/`truncated`语义，不能用过滤后的当前页长度推断catalog已完整。
- 带精确session ID的load/resume、transcript/export、archive/unarchive/delete与organization操作，可在对应archive lock内证明该ID的location、source与internal transcript ownership后opt in；batch要求每个ID都通过且全部解析到同一runtime，任一失败、歧义或跨runtime则整个mutation在副作用前拒绝。
- aggregate `session-info`、session-groups CRUD、无source filter的catalog list以及仅凭internal cwd/ID的操作仍按ordinary workspace拒绝。普通top-level session creation不得选择internal；已有internal owner session发起并由owner index证明的branch/fork/side-task/sub-session派生创建继续允许。

这保持设计文档允许的“owner-routed session/catalog operations”兼容面，同时让settings/Git/files/ACP/voice等普通workspace表面无法借`kind: live` entry寻址internal。当前实码中Live Sidebar的`WorkspaceSection`直接传`selectedSessionSource`：默认tab会发送`default`，但Channel tab会改成`channel`。下述最小WebShell兼容改动必须让Live section在daemon广告`session_source_metadata`时固定发送`sourceType=default`，不随project tab切换；旧daemon未广告该feature时仍传`undefined`并维持unfiltered legacy请求。不能为迁就client而放宽新daemon。

`POST /session/:id/load|resume` 保留 PR0/Live 兼容，但 internal opt-in 不能由 cwd 单独授权。resolver先按普通 workspace规则处理；若请求显式命中 internal ID/cwd，只能形成尚未授权的 candidate，不能设置 telemetry、预留session ID、materialize目录或调用bridge。进入该session ID的既有archive shared lock后，必须先满足以下任一ownership入口，再完成共同校验：

- session owner index精确命中同一个 internal runtime；或
- `assertSessionLoadable` 在该runtime catalog中返回实际location（`undefined`不是成功），且随后source helper证明它是compatible Live或既有projectless legacy transcript。

无论从哪个入口进入，bridge调用前都再次要求 transcript location存在、source兼容、runtime generation仍open；这些检查与requested-session-ID reservation和load/resume保持在同一个archive shared section内，避免校验后换档。未知session、foreign/project source、owner冲突或candidate失效统一拒绝，不触碰internal bridge并且不回退primary。owner-routed transcript/status等现有按session ID入口继续使用owner index，不新增通用internal path resolver。这里仅兼容PR0已支持的Live/legacy projectless source；PR1不接受未来显式`standalone` source，也不创建新route。

无selector的精确transcript/batch resolver在扫描active ordinary runtime前，还必须检查`listManaged()`中的internal persistence target：若该ID在inactive internal entry中实际存在或读取返回structured compromise，分别返回runtime-unavailable或原错误，不能因`list()`跳过inactive entry而命中primary同UUID。该检查只发生在session ID的archive lock内，不返回internal identity，也不把任意cwd变成selector。

### Reserved registration path

普通 startup、persisted restore 和 `POST /workspaces` 不得把 Conversations root 本身或其子目录注册为 `existing` runtime：

- `ConversationWorkspace.rootPath` 提供不创建目录的 configured root；root 已存在时同时比较安全 canonical identity。
- 显式 `--workspace` 命中时启动失败并返回不含真实 canonical target 的明确 reserved-workspace error。
- persisted registration 命中时跳过并写 sanitized warning，不启动 child。
- 动态 registration 命中时返回 `409 conversation_workspace_reserved`，且发生在 persistence、runtime creation 和 registry mutation之前。
- 遗留 registration store 中已存在的 reserved root/child 仍可作为 `active: false` 的持久化脏数据列出并删除，但 list/forget 不能把它绑定到 internal runtime：不返回 `restartRequired`，不修改 internal metadata，也不触发 runtime removal。
- 更高层的父 workspace 不在 PR1 禁止范围内；阻止它会破坏既有 broad-workspace 用法。internal runtime 的精确 registry entry 仍由 default-deny selector 隐藏，文件系统的父 workspace containment policy 不在本 PR 改写。

Owned publication继续只接受exact validated Conversations root。若registry已有non-internal exact entry，manager固定返回non-retryable `conversation_root_compromised`，不复用、不替换、不回退primary。

## Direct-consumer classification

实现时必须按下表逐项落测试；仅改 shared resolver 不算完成。

| Consumer                                                                                                                                                                                                     | Scope                                   | PR1 行为                                                                                                                                                                                                                                                                                                               |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ConversationRuntimeManager`                                                                                                                                                                                 | internal exact owner                    | acquire owner 后才 revalidate；在最终 PR0 的pre-publication validator中再验candidate/exact root，通过后才publish/use；失败无primary fallback                                                                                                                                                                           |
| `routes/session-runtime.ts`、`routes/permission.ts`、`routes/sse-events.ts`、session owner index、requested session-ID admission/persistence targets，以及除下述A2UI例外外的既有owner-routed`/session/:id/*` | owner/global identity                   | 保留internal用于跨runtime UUID查重和按ID路由（含prompt/status/subagent/permission/SSE/shell等）；indexed internal处于inactive state时返回unavailable且禁止scan/fallback primary；ordinary冲突响应要redact internal owner ID/cwd，不能为隐藏它而跳过查重                                                                |
| `routes/session.ts` creation/catalog/session selectors                                                                                                                                                       | ordinary + narrow compatibility         | ordinary top-level creation/aggregate/group拒绝internal；owner-routed派生创建保留，source-filtered list和精确session-ID操作仅在owner/locked transcript/source proof后opt in，batch先全量验证                                                                                                                           |
| generic settings/trust/Git/files/GitHub/extensions/skills/MCP/memory/agents/tools/status/lifecycle/workspace-permissions/voice/channel-notify routes                                                         | ordinary workspace                      | ID和cwd均返回`workspace_mismatch`，不调用internal service/bridge/fs/worker                                                                                                                                                                                                                                             |
| workspace-qualified channel management与observed contacts                                                                                                                                                    | ordinary + narrow Live compatibility    | 普通runtime不变；active internal只允许既有GET read surface，所有POST/PUT/PATCH/DELETE仍拒绝。显式compatibility resolver不得变成generic selector，也不得触发任意internal boot；internal handler全程持有activity gate lease                                                                                              |
| workspace-qualified scheduled-task routes                                                                                                                                                                    | ordinary + narrow Live compatibility    | active internal仅允许list及对已存在Live-owned task的update/delete/manual-run；base create保持`live_session_creation_reserved`。internal handler全程持有activity gate lease；keepalive/rehydration继续排除internal，不能借兼容面创建standalone durable task                                                             |
| primary-bound Goals、A2UI action、workspace auth/models/setup-GitHub/channel-control                                                                                                                         | legacy primary surface                  | 保持绑定ordinary primary；不得因`:id`或user-global写入而改选internal。A2UI当前不证明session ownership，PR1不借其session ID扩大internal访问；user-global reconciliation仅走既有显式fanout                                                                                                                               |
| `acp-http/index.ts` REST mount、ACP WS、Voice WS                                                                                                                                                             | ordinary workspace transport            | internal 不创建 secondary mount；upgrade 返回 400 mismatch，不能落到 primary mount                                                                                                                                                                                                                                     |
| `routes/workspace-management.ts`                                                                                                                                                                             | user management + internal publisher    | patch/delete/promote/list-by-selector 排除 internal；遗留reserved registration只能按inactive store entry清理；`publishOwnedRuntime` 是唯一明确 internal admission                                                                                                                                                      |
| `routes/workspace-extensions.ts`                                                                                                                                                                             | targeted workspace + user-global config | workspace-qualified route和全局`POST /extensions/install`的workspace activation均拒绝internal；user-global mutation可按既有语义reconcile internal，但不能借此返回或选择它；internal reconciliation全程持有activity gate lease且shutdown后不晚启动                                                                      |
| `channel-worker-group.ts`、channel grouping、scheduled keepalive                                                                                                                                             | ordinary background workspace           | 排除 internal；即使注入了伪造 group 也 fail closed                                                                                                                                                                                                                                                                     |
| device-flow event fanout                                                                                                                                                                                     | daemon-global session auth              | 保留 trusted internal bridge，避免 owner-routed session的 auth事件丢失；该 fanout不提供 workspace selector                                                                                                                                                                                                             |
| per-runtime sub-session launcher、session-originated channel delivery与bridge callbacks                                                                                                                      | runtime-owned session capability        | 保留已授权internal session的既有能力并参与shutdown；不得反向提供cwd/ID selector，普通channel grouping/keepalive仍排除internal                                                                                                                                                                                          |
| `fs/workspace-file-system.ts`、`server/fs-factory.ts`、`routes/workspace-extensions-controller.ts`、`virtual-subagent-sessions.ts`、`voice/workspace-voice-coordinator.ts`、`workspace-runtime-storage.ts`   | admitted-runtime helper                 | 自身不选择registry entry，只接收调用方已授权runtime或generation guard；不得blanket拒绝internal而破坏owner session，也不得新增反向ID/cwd选择器。隔离在其所有调用点证明                                                                                                                                                  |
| capability feature predicates                                                                                                                                                                                | mixed compatibility/user surface        | generation等owner-routed能力可继续计入internal；`multi_workspace_sessions`、workspace-qualified ACP/voice/memory与scratch registration只由ordinary runtimes驱动                                                                                                                                                        |
| telemetry URL workspace selector                                                                                                                                                                             | ordinary selector + proven owner        | ID/cwd过滤internal；被拒绝/未知/非法selector不产生workspace hash，也不误记到primary。任何获准的精确internal session操作（legacy或workspace-qualified）只能在handler完成owner/locked transcript proof后设置internal attribution；source-filtered catalog可保持无attribution；非workspace route仍沿用primary attribution |
| `live/live-session-coordinator.ts`、`live/live-task-service.ts`、`live/realtime-startup-context.ts`                                                                                                          | dedicated Live                          | 明确保留 internal；project selector仍拒绝 internal，projectless/owner lookup可使用                                                                                                                                                                                                                                     |
| `routes/health.ts`、usage dashboard                                                                                                                                                                          | aggregate observability                 | 可聚合 internal counters/usage；不返回 path/provenance或internal workspace identity                                                                                                                                                                                                                                    |
| `routes/capabilities.ts`                                                                                                                                                                                     | compatibility allowlist                 | 仅active/current internal entry可按固化entry scope展示`kind: "live"`；inactive internal隐藏，不能因current缺失退化成普通workspace；limits仍反映实际admission pools                                                                                                                                                     |
| `daemon-status.ts`、`routes/daemon-status.ts`                                                                                                                                                                | aggregate + presentation                | process/session/resource aggregate可计入 internal；普通 `workspaces[]` 与 path-bearing issue文本不把它呈现为 user workspace                                                                                                                                                                                            |
| metrics/resource sampling、`workspace-trust-reconciler.ts`、runtime drain/removal、shutdown                                                                                                                  | process ownership/lifecycle             | 保留 internal；trust reconciler继续跳过 user-policy replacement，shutdown必须 dispose它                                                                                                                                                                                                                                |
| runtime-owned settings/tool persistence callbacks                                                                                                                                                            | internal runtime owner callback         | 允许已知runtime保存自身状态；普通workspace settings/tools route仍走default-deny resolver，不能借callback seam按任意cwd选择internal；异步internal callback必须由bridge lifecycle或activity gate持有                                                                                                                     |

Shared ordinary resolver覆盖的route文件至少包括下列清单；其中channel read与scheduled-task既有Live操作必须使用单独、method/operation受限的compatibility seam，不能被default-deny resolver误杀，也不能把该seam复用到其他route：

```text
channel-notify.ts
scheduled-tasks.ts
workspace-channel-management.ts
workspace-channel-observed-contacts.ts
workspace-extensions.ts
workspace-file-read.ts / workspace-file-write.ts
workspace-git.ts / workspace-git-branches.ts / workspace-git-diff.ts / workspace-git-log.ts
workspace-github-prs.ts
workspace-lifecycle.ts
workspace-mcp-control.ts
workspace-permissions.ts
workspace-settings.ts
workspace-skills.ts
workspace-status.ts
workspace-tools.ts
workspace-trust.ts
workspace-voice.ts
workspace-agents.ts
workspace-memory.ts
```

每次同步 main 后，任何新增的 direct registry consumer 必须加入表中并归类；无法明确 owner scope 的 consumer 默认按 ordinary workspace 处理。

## Shutdown ordering

共享`ServeAppLifecycle.close()`拥有listener、app-local drain与ownership release gate；`RunHandle.close()`只向它委托common shutdown，并在绑定时用唯一的`drainHost`回调纳入channel worker、process registry等host-owned drain，不把`finish()`等同于listener已关闭，也不另建release state machine。handle的第一个同步阶段先设置daemon-wide admission seal，让已装配的HTTP/upgrade入口拒绝新工作；若listener已成功启动，则立即发起唯一一次`server.close()`并保存其callback结果，不要等bridge/child drain完成才停止接收新请求。若embed先直接调用了`server.close()`，绑定时安装的`close` listener同步执行相同seal并启动同一个cleanup promise；之后调用`ServeAppLifecycle.close()`只await/retry该状态，不创建第二条清理链。从未成功listen的startup-failure分支不对non-listening server发起新close，仍只接受已有listener close event/callback的无错proof；该分支在设计上也不应已claim owner。callback可以先于其他drain完成，但只记录正向proof，绝不提前release：

1. seal daemon-wide route/upgrade admission、workspace management、Live coordinator和session maintenance，并同步保存各component的drain promise；不得在这里先等待某个activity归零；
2. 立即停止会产生新工作的trust monitor/maintenance/event producers，调用绑定时提供的`drainHost`，并向SSE、ACP/voice transports、channel workers和所有runtime bridge发起cooperative drain/abort；`drainHost`必须在调用时同步发起host seal/stop并返回可等待promise，不能等app-local drain结束后才停止host producer。各component drain先封住自身admission，再等待或取消其owned lease，最后dispose child。所有允许internal的入口必须映射到一个明确drain owner：manager boot/acquire归boot hook，dedicated Live归Live coordinator，transcript/export/archive/organization与load-resume validation归`SessionArchiveCoordinator`，bridge/session/SSE操作归bridge或subscriber drain，source-filtered internal catalog、Live channel/scheduled-task兼容面、user-global extension reconciliation及其他非bridge异步callback归一个只在internal proof后进入的窄`ConversationRuntimeActivityGate`。该gate只提供`run(task)`与`sealAndWait()`，不解析ID/cwd、不成为第二个policy framework。`runSharedMany`与`runExclusiveMany`都必须在seal后拒绝新工作、计入同一个maintenance drain；activity gate也必须在seal后拒绝晚启动。不能只追踪mutation而漏掉已断开client后仍运行的shared filesystem或已返回202的background reconciliation。先发出能让长连接/等待中handler退出的信号，再联合等待这些component promise、`drainHost`与shared process registry，避免SSE或bridge请求与shutdown互相等待。普通generic route无法选择internal，因此无需侵入Express实现一个不可靠的全局async-handler tracker；若新增internal seam却无法归入上述drain owner，必须先补lifecycle ownership。关键stop/dispose helper必须返回或聚合错误，不能只warn后让release gate通过；
3. 等待开始阶段已发起的`server.close()`；只有callback无error且步骤2的internal component drain均有正向proof（不是仅socket被force-close）才设置`listenerCloseConfirmed = true`；
4. seal discovery toggle、停止retry，并等待所有已开始的publish/toggle/retry promise settled后，才移除当前进程在stable与runtime base下曾发布的全部Live discovery records；不能先观察absent再让迟到publish写回。每个target都要把“exact owner removed”“已不存在”“foreign/malformed”“I/O failure”分开，前两者可确认无本进程locator，后两者进入lifecycle error，不能继续用boolean/吞错后假装成功；
5. 仅当步骤 1-4 均确认成功且没有management/Live/session/trust/bridge/channel/process drain error时，调用 nonce-checked `ownership.release()`；
6. 最后完成 telemetry/logger cleanup 和 close promise settlement；这里的失败属于post-release lifecycle error，可记录/返回但不能倒推出owner record仍存在、重做release或把它混入步骤5的前置proof。

所有无法证明drain完成的seal/stop/dispose promise都必须显式归并到本次`close()`的lifecycle error accumulator；不能依赖`.finally()`后丢失rejection，也不能catch-log后仍通过release gate。跨重试保存的是各阶段的正向proof state，而不是永久累加所有历史transient error：首次secondary deadline/channel retry仍让该次`close()`拒绝，但迟到listener success或后续worker/service exit可更新proof并允许下一次调用通过；callback error、foreign cleanup、bridge/process dispose等非暂态失败没有正向重试证明时持续阻断。已经settled的Live boot/ensure业务失败本身不是“仍在运行”，可在seal确认没有in-flight work后继续释放其已claim owner。secondary deadline只负责让`close()`有界返回，必须记录listener-unconfirmed error，不能设置`listenerCloseConfirmed`或release。`server.listening === false`的startup-failure分支只有在现有`runtimeFailureListenerClose`保存了无error callback结果时才可release；“从未listen且从未claim”则由无I/O release no-op覆盖。

retryable channel/service drain、locator I/O proof缺失与listener secondary deadline必须在该次`close()`拒绝后清除settled close promise、保留全局seal与所有正向proof，从而只重开`close()`重试门，不宣称listener/bridge已恢复服务，也不重新接纳请求。`server.close`迟到callback即使首个close已settled也要记录其success/error；embed可在proof更新后再次调用共享handle的`close()`，复用已完成的drain/locator状态并完成owner release。第二次调用只有在worker/service lease真正退出、`drainHost`取得正向proof、所有曾发布Live locator均有清理正向证明且listener曾确认关闭后才release；callback永不到达则继续fail closed。若pre-unlink ownership、任一foreign/malformed Live cleanup或其他无法取得新正向proof的非暂态drain本身失败，`close()`拒绝且不修改观测到的owner/locator状态；当前匹配record仍存在时保留，missing/foreign/invalid则保持原样。exact unlink后的lock cleanup失败按前述post-unlink状态拒绝但record已安全移除。signal-owned CLI对非retryable错误随后以非零退出，使仍存在的record可在PID死亡后reclaim；retryable rejection后下一次signal可发起新close cycle，而同一cycle尚未settled时的第二次signal仍force-exit。embed caller不得把rejected handle当成已安全handoff；绑定后直接关闭server但不await handle的caller只能获得event-triggered best-effort cleanup，公开契约不保证其进程在异步release完成前保持存活。force-exit、uncaught fatal path和in-flight第二次signal均不尝试异步release。

Ownership只记录上述四态与terminal compromise：若foreign/compromised的是Conversations owner record且本次从未commit/确认当前nonce，仍为unclaimed，release是无I/O no-op；fresh/same-owner/dead-handoff commit后为provisional，只有完整acquire成功才owned。release与pending acquire串行；pending失败若留在provisional则拒绝unlink，owned遇到missing/foreign/malformed也绝不按“清理best effort”强删，exact unlink后的lock cleanup failure按上述post-unlink released状态处理。

## Implementation tasks

### Task 0：确认 merged baseline 与 consumer inventory

**Files:** 本计划、PR0 changed files、所有 `WorkspaceRegistry` direct consumers。

- [ ] 实现开始前 fetch 最新 main，确认 `c9cb53398dcf7faa9e70a30f7f38b5946cf2def1` 仍是实现基线的 ancestor；若main前进，只 rebase PR1 自身提交。
- [ ] 记录 `git diff --stat origin/main...HEAD` 与 PR1 production line budget，确认 PR1 没有越过 core-refactor gate；不把 squash 前 PR0 head 计入 PR1 diff。
- [ ] 以upstream design的300-550 production lines为review budget：超过550先去掉重复guard/抽象并重新审计；若安全contract客观无法在该预算内实现，先更新design并向maintainer说明，不靠隐藏的大重构硬塞。不得引入通用policy framework、第二registry或可配置lease系统。
- [ ] 实现期行数审计：集成工作树当前约3,071行production新增、651行production删除，明显越过review budget。发布前必须先完成去重/简化审计，再把可独立验证的ownership+lifecycle、default-deny registry/transport、narrow compatibility+WebShell切成review slices；若依赖关系证明无法安全拆分，则在创建PR前由maintainer明确接受该规模。集成测试继续在完整工作树运行，不能用拆分掩盖跨slice回归。
- [ ] 使用 `rg` 重建 shared resolver 与 direct registry consumer 清单，逐项填入 allow/deny classification。
- [ ] 运行 PR0 focused tests，确认 baseline 不是从红灯开始。

### Task 1：先写 ownership RED tests，再实现 stable owner

**Files:**

- Create: `packages/cli/src/serve/conversations/conversation-runtime-ownership.ts`
- Create: `packages/cli/src/serve/conversations/conversation-runtime-ownership.test.ts`
- Create: `packages/cli/src/serve/conversations/conversation-runtime-errors.ts`
- Modify: `packages/cli/src/serve/live/discovery.ts`
- Modify: `packages/cli/src/serve/live/discovery.test.ts`

- [ ] 覆盖fresh acquire、same-owner idempotency、concurrent one-flight、unclaimed active foreign owner、dead reclaim + exactly-once grace、PID reuse、owned后reacquire遇到missing/foreign/dead/invalid record一律terminal compromise且不重建、篡改后恢复exact record仍不可洗掉terminal、未claim/重复release、owned-record missing/nonce mismatch release、unlink成功后lock cleanup失败与acquire/release竞态。
- [ ] 对owner commit之后的legacy exact removal与Live/owner lock cleanup注入错误，断言首次即返回non-retryable ownership compromise、状态停在terminal provisional、同进程不能重试成功、release不unlink current record；另以child process在只resolve grace中退出，证明后继把dead provisional record当stale owner重新等待grace。
- [ ] 覆盖首次acquire逐级创建缺失stable tree，以及file/dir/intermediate/lock symlink、hard-link record、`mkdir`/`EEXIST`与`lstat/open`竞态、parent/directory identity replacement、wrong mode、wrong uid（平台支持时）、non-file、empty/oversize/malformed/unknown-key/unknown-version record与compromised lock；断言unsafe既有组件不被`chmod`修复且无overwrite/unlink。
- [ ] 两个不同`QWEN_HOME`/`QWEN_RUNTIME_DIR`但相同real HOME的实例必须解析到同一个default owner/Live stable base；只有显式test/embed `liveDiscoveryStableBaseDir`能改写，且同时作用于两者。
- [ ] 覆盖legacy Live inspection在directory absent时不创建、首次publish安全逐级创建、unsafe existing directory fail closed且不修复、active/dead/same-owner/malformed record、dead locator只在current owner commit后exact removal、commit/remove失败路径、exactly-once grace，以及Live discovery write在acquire后遇到新foreign owner时仍拒绝。
- [ ] 覆盖lock正常busy的bounded retry与耗尽后的retryable unavailable、stale/unsafe/compromised lock的non-retryable compromise、正常commit后先release lock再等待不可取消grace、Windows destructive gap失败在lock内等待grace、shutdown与acquire并发，以及custom `onCompromised`不产生uncaught exception。
- [ ] Live discovery removal区分exact removed、already absent、foreign/malformed和I/O failure；stable与runtime base不同时逐target记录proof，全部写入后才ready。第二target写失败时补偿移除本次已写target；补偿失败仍保留published proof requirement。shutdown只在全部曾发布target都得到前两种结果后视为本进程locator已清理。
- [ ] 使用真实 child processes 做 contention：测试动态写一个 `.mjs` worker，通过 `node --import tsx` import TS module；A acquire 并保持存活，B 得到 `conversation_runtime_in_use`；A 被终止且不 release 后，C reclaim 并执行 grace。不能用同进程 `Promise.all` 冒充 two-process coverage。

### Task 2：把 ownership 接到 manager、Live discovery 和 structured errors

**Files:**

- Modify: `packages/cli/src/serve/conversations/conversation-runtime-manager.ts`
- Modify: `packages/cli/src/serve/conversations/conversation-runtime-manager.test.ts`
- Modify: `packages/cli/src/serve/server.ts`
- Modify: `packages/cli/src/serve/server.test.ts`
- Modify: `packages/cli/src/serve/routes/live.ts`
- Modify: `packages/cli/src/serve/routes/live.test.ts`
- Modify: `packages/cli/src/serve/index.ts`
- Modify: `packages/cli/src/serve/run-qwen-serve.ts`
- Modify: `packages/cli/src/serve/run-qwen-serve.test.ts`

- [ ] `runQwenServe`解析一次stable base；在`LiveHostCoordinator`创建后，通过identity-bearing factory seam用同一PID/nonce/base构造side-effect-free ownership object，放入app lifecycle locals并把同一实例传给manager/discovery gate。`createServeApp`默认factory只构造、不执行I/O；tests注入无外部资源的fake。未绑定listener时internal ensure fail closed且绝不写真实home，绑定并listening后才允许boot。
- [ ] 在`server.ts`实现唯一的`ServeAppLifecycle`并从`serve/index.ts`导出类型与`getServeAppLifecycle(app)`；保持`createServeApp(): Application`返回类型不变。`bindServer`只接受一个尚未listening的真实Node server，在首次listen前绑定并观察后续`listening`/`error`/`close`状态，把可选`startupReady`和`drainHost`纳入同一boot/release gate。`runQwenServe`必须绑定并委托该handle，不能保留平行的owner release逻辑；HTTP与HTTPS都先显式create/bind一个server并跨port retry复用，transient listen error不close/seal，最终startup failure才reject host readiness。direct embed绑定后的raw `server.close()`也启动同一cleanup，awaitable shutdown走`ServeAppLifecycle.close()`。
- [ ] manager `ensure()` 先 acquire，再 root revalidate/publish；concurrent ensure仍只 publish一次，owner/root/runtime errors按contract映射；wrong provenance/primary/trusted/removable候选均为non-retryable root compromise。
- [ ] Live discovery enable/publish 等待同一个boot同时证明 acquire和active internal publication；contention/root/runtime失败时不写 locator、不启动/复用错误 runtime、不 fallback primary。
- [ ] `createServeApp` assembly不启动owner I/O；所有eager/lazy internal caller先共享lifecycle boot-admission barrier。production仅在server已绑定、listener成功、app已被cleanup owner捕获、channel/runtime startup其余可失败门禁通过且现有Live eager-boot条件成立后，在discovery publication/readiness前调用one-flight hook；direct-app Live-enabled capabilities/Live catalog/dedicated Live request必须使用显式fake ownership、pre-listen bound ephemeral listener并在listener ready后lazy触发。production channel startup期间的capabilities探测必须200返回ordinary snapshot且不等待/claim，防止worker-ready↔barrier死锁；barrier open且boot开始后capabilities才等待settlement，settled failure后轮询不反复acquire，显式Live/internal请求仍可重试。Live catalog preflight只对精确configured internal target + `sourceType=default`生效；任意ordinary selector和无source catalog不触发claim。Live-disabled ordinary daemon不claim；ownership失败不伪造entry；特别覆盖unbound direct app零I/O、already-listening/重复/异server/late binding拒绝、direct pre-listen error seal、production transient port retry不seal/不换server、最终listen failure与channel startup failure在启动promise reject前走共享close、retryable host drain保留cleanup owner、channel worker在ready前真实fetch capabilities、loser在winner退出后由显式请求成功retry、Live请求与channel startup并发时不提前acquire，以及assembly throw、boot-before-close、close-before-boot均无泄漏/无晚启动。
- [ ] Live disable不 release；ownership已成功后发生的root/runtime初始化失败可在operator修复后由同一daemon显式retry（`retryable: false`仍禁止client自动重试unsafe root），foreign daemon仍被owner挡住；post-commit ownership compromise保持terminal provisional，不能在同进程“修复”后跳过grace。
- [ ] 为`/live/start`与`/live/new`增加awaitable runtime-ready preflight；后台eager boot失败不影响ordinary routes，但这两个真实Live请求必须重用同一one-flight并在coordinator action前失败，不得先返200。添加route-level structured error serializer tests，断言status/code/retryable且response/用户可见log无base dir、canonical root、nonce、foreign PID；既有`LiveUnavailableError`响应保持兼容。

### Task 3：实现 lifecycle-safe release

**Files:**

- Create: `packages/cli/src/serve/conversations/conversation-runtime-activity.ts`
- Create: `packages/cli/src/serve/conversations/conversation-runtime-activity.test.ts`
- Modify: `packages/cli/src/serve/server.ts`
- Modify: `packages/cli/src/serve/server.test.ts`
- Modify: `packages/cli/src/serve/server/session-archive.ts`
- Modify: `packages/cli/src/serve/server/session-archive.test.ts`
- Modify: `packages/cli/src/serve/run-qwen-serve.ts`
- Modify: `packages/cli/src/serve/run-qwen-serve.test.ts`

- [ ] 注入fake ownership，分别经`RunHandle.close()`与direct embed共享handle逐个卡住management/live/session/trust/activity drain、`drainHost`、bridge child、process registry、Live discovery publish/toggle/retry、stable或runtime-base cleanup和`server.close` callback，证明release只发生在全部完成后，且seal后没有迟到locator write；每个rejection都进入lifecycle accumulator而非被`.finally()`/catch-log吞掉。
- [ ] 实现最小`ConversationRuntimeActivityGate`，只计数已通过internal proof的非bridge异步操作；`sealAndWait()`同步拒绝晚启动并等待已有task finally释放，不读取selector、不捕获普通route。断言`close()`同步封住daemon-wide HTTP/upgrade admission并只发起一次`server.close()`；先向SSE与各component发出cooperative drain/abort，再联合等待internal drain owners退出，不能先等activity而饿死其退出信号，也不能把force-close后的listener callback误当成handler已settled。`SessionArchiveCoordinator`在seal后同时拒绝/等待shared与exclusive操作；逐项证明每个internal opt-in归属manager boot、Live、archive coordinator、activity gate或bridge/subscriber drain。在internal export/shared filesystem操作、已返回202的extension reconciliation、Live channel/scheduled-task兼容操作、SSE、bridge或worker drain被卡住时不release，后到请求不能进入runtime。listener callback早于drain完成也不release，而drain完成但callback未到也不release。
- [ ] 覆盖正常close、每类drain error、close callback error、bridge error、channel retry后第二次close、force-close后callback成功、secondary deadline时拒绝且不release、迟到success callback后embed第二次close完成release、direct embed调用共享`close()`、direct embed先raw `server.close()`再await共享handle、未await event cleanup的明确best-effort边界、pre-eager-hook daemon startup failure仍unclaimed、Conversation boot失败的unclaimed/provisional/owned状态、telemetry/logger post-release cleanup失败不重做release、重复close与第二次signal force exit。
- [ ] 断言drain/listener proof不完整时不调用unlink且匹配record保持；release校验遇到missing/foreign/invalid时不修改观测状态；exact unlink后的lock cleanup失败则`close()`拒绝但record已不存在、claim已清除；完整成功路径release恰好一次且位于Live discovery removal之后。

### Task 4：把普通 workspace resolver 改成 default deny

**Files:**

- Modify: `packages/cli/src/serve/workspace-registry.ts`
- Modify: `packages/cli/src/serve/workspace-registry.test.ts`
- Modify: `packages/cli/src/serve/workspace-route-runtime.ts`
- Modify: `packages/cli/src/serve/workspace-route-runtime.test.ts`
- Modify: `packages/cli/src/serve/routes/session-runtime.ts`
- Modify: `packages/cli/src/serve/routes/session-runtime.test.ts`
- Modify: `packages/cli/src/serve/routes/session.ts`
- Modify: `packages/cli/src/serve/multi-workspace-sessions.test.ts`
- Modify: `packages/cli/src/serve/live/live-task-service.ts`
- Modify: `packages/cli/src/serve/live/live-task-service.test.ts`

- [ ] 对 entry、active runtime、managed runtime 的 ID/cwd/canonical/lexical selector 写 RED matrix，internal一律 mismatch，普通 primary/secondary行为不变。
- [ ] `activateReplacement`拒绝 user/internal scope变化；transitioning、draining和blocked entry仍按固化scope过滤，removed entry按registry现有删除契约不可再选择。
- [ ] 扩展session owner resolution为显式unavailable outcome：internal entry进入transitioning/draining/blocked时不按ordinary replacement逻辑清空其owner index；indexed internal处于这些状态时保留index并禁止scan到primary，active owner明确session-not-found或entry removed才清除stale index。无index的精确transcript/batch lookup也先在archive lock内检查managed internal persistence target，再扫描active ordinary runtime。逐一更新`routes/session-runtime.ts`、`routes/session.ts`、permission/SSE消费者与`live/live-task-service.ts`，返回sanitized runtime-unavailable；分别用indexed与cold-persisted internal + primary同UUID夹具证明无fallback。
- [ ] ordinary top-level session creation不能选internal，restore不能由cwd单独授权internal；未知session + internal cwd也不能fallback primary。owner-routed branch/fork/side-task/sub-session派生创建保持可用且沿用internal runtime/private-directory规则。
- [ ] singular/plural catalog按窄例外分类：无source list、session-info、groups CRUD拒绝internal；显式`sourceType=default`的Live list在输出metadata过滤后兼容，并在internal proof后、任何catalog I/O前持有activity gate lease；精确session和batch操作在locked per-ID proof后兼容，batch先验证全部且要求同一runtime，跨runtime/歧义整批拒绝后才允许产生副作用。
- [ ] active owner-routed Live session的全部既有session-ID操作（含prompt/status/subagent/permission/SSE/shell等）与精确transcript操作，以及cold compatible Live/legacy transcript的load/resume/transcript/export/archive路径继续按上述owner/locked proof opt in；A2UI仍按表中primary-bound例外处理，UUID admission继续跨internal查重。用当前WebShell list/load请求形状做fixture，避免方案自洽但实际UI回归。
- [ ] 精确configured internal target + `sourceType=default`的catalog在ordinary resolver前等待boot，并把boot typed error原样序列化；精确internal load/resume candidate可等待同一boot，但boot成功仍不等于session授权，必须再完成locked location/source/owner proof才能调bridge。无source、任意ID/cwd和ordinary selector断言不触发boot。
- [ ] internal restore candidate在source/location验证前不设置telemetry、不reserve ID、不materialize、不调用bridge；`readCreationMetadata()`的空对象不能让不存在的session通过。owner冲突、project source和generation变化均fail closed。
- [ ] mismatch、ambiguous-owner、workspace-conflict与requested-ID admission响应均不泄露internal ID/cwd/count；查重和内部日志关联仍保留sanitized/hash identity。

### Task 5：封住 HTTP、WebSocket 与 workspace-management 旁路

**Files:**

- Modify: `packages/cli/src/serve/acp-http/index.ts`
- Modify: `packages/cli/src/serve/acp-http/workspace-qualified-acp.test.ts`
- Modify: `packages/cli/src/serve/routes/workspace-qualified-voice.test.ts`
- Modify: `packages/cli/src/serve/routes/workspace-management.ts`
- Modify: `packages/cli/src/serve/routes/workspace-management.test.ts`
- Modify: `packages/cli/src/serve/run-qwen-serve.ts`
- Modify: `packages/cli/src/serve/run-qwen-serve.test.ts`

- [ ] ACP REST、ACP WS、Voice WS分别用 internal ID 和 encoded cwd测试；断言 400、无 mount/upgrade/bridge调用、无 primary fallback。
- [ ] secondary mount factory自身再做 internal guard，防调用者漏过滤。
- [ ] patch/delete/persist/promote/select internal均不可达；owned publication仍可发布唯一 exact internal root。
- [ ] 增加不创建root的reserved-path classifier，覆盖configured/canonical root、child、alias与path-boundary；随后覆盖显式startup reserved root、persisted root/child skip、dynamic root/child `409 conversation_workspace_reserved`，以及父workspace在internal已发布和publication in-flight两种状态都保持兼容。
- [ ] legacy store若含reserved root/child，registration GET仅把它作为inactive persisted entry呈现；DELETE只移除store记录，不绑定/修改/移除internal runtime，也不返回`restartRequired`。

### Task 6：参数化覆盖所有 generic route family 与后台 consumer

**Files:**

- Modify: `packages/cli/src/serve/routes/workspace-extensions.ts`
- Modify: `packages/cli/src/serve/routes/workspace-qualified-extensions.test.ts`
- Modify: `packages/cli/src/serve/routes/workspace-channel-management.ts`
- Modify: `packages/cli/src/serve/routes/workspace-channel-management.test.ts`
- Modify: `packages/cli/src/serve/routes/workspace-channel-observed-contacts.ts`
- Modify: `packages/cli/src/serve/routes/workspace-channel-observed-contacts.test.ts`
- Modify: `packages/cli/src/serve/routes/scheduled-tasks.ts`
- Modify: `packages/cli/src/serve/routes/scheduled-tasks.test.ts`
- Modify: `packages/cli/src/serve/routes/channel-notify.test.ts`
- Modify: `packages/cli/src/serve/routes/workspace-trust.test.ts`
- Modify: `packages/cli/src/serve/routes/capabilities.ts`
- Modify: `packages/cli/src/serve/routes/health.ts`
- Modify: `packages/cli/src/serve/server.ts`
- Modify: `packages/cli/src/serve/server/telemetry.ts`
- Modify: `packages/cli/src/serve/server/telemetry.test.ts`
- Modify: `packages/cli/src/serve/daemon-status.ts`
- Modify: `packages/cli/src/serve/daemon-status.test.ts`
- Modify: `packages/cli/src/serve/workspace-trust-reconciler.ts`
- Modify: `packages/cli/src/serve/workspace-trust-reconciler.test.ts`

- [ ] 建立一个 internal runtime route harness，按 Direct-consumer classification 对每个 generic route family至少测试 ID/cwd一种选择，并对高风险 mutation同时测两种。
- [ ] 每个断言不仅检查 response，还检查 internal bridge/workspace service/fs/extension manager/channel worker没有调用。
- [ ] 复核primary-bound `goals.ts`、`a2ui-action.ts`、`workspace-auth.ts`、`workspace-models.ts`、`workspace-setup-github.ts`与`workspace-channel-control.ts`：不新增internal选择/fanout；全部既有owner-routed session-ID路径（含permission/SSE/shell）仍通过owner index命中internal，legacy unqualified permission继续只走primary。
- [ ] extension targeted routes和全局install接口的workspace activation均排除internal；global extension reconciliation继续覆盖internal且不暴露selector，并在每个internal target的异步刷新外持有activity gate lease，gate sealed后不晚启动。device-flow fanout、per-runtime sub-session launcher、session-originated channel delivery和bridge callbacks继续覆盖trusted internal session。channel worker grouping和scheduled keepalive排除internal；runtime-owned settings/tool persistence callback继续可保存internal自身状态但没有任意cwd入口，非bridge异步callback同样持有activity gate lease。
- [ ] 保留上游设计的两类Live兼容例外：qualified channel management/observed contacts对active internal只开放GET read surface；qualified scheduled tasks对active internal允许list与既有task的PATCH/DELETE/manual-run，POST base create仍拒绝。internal handler在proof后、任何service/fs调用前取得activity gate lease并在finally释放。按每个HTTP method测试，断言兼容resolver不被其他generic route调用、不因任意ID/cwd触发boot、不启动channel worker或scheduled keepalive，也不能创建新的internal task/session；shutdown seal后返回daemon-draining且无调用。
- [ ] telemetry resolver改为可返回“无workspace attribution”：internal、unknown、malformed workspace selector不产生workspace hash且不记到primary，非workspace route和有效普通workspace的既有attribution不变；telemetry失败仍不影响请求处理。
- [ ] 逐项审计因PR1而新增internal owner routing的session telemetry route：当前legacy`GET /session/:id/export`与`PATCH /session/:id/organization`是pre-resolved primary attribution，workspace-qualified transcript/export/batch routes也在handler proof前pre-resolve。凡按Task 4通过owner/locked transcript proof支持internal的精确或batch操作，都必须改为handler-resolved并只在proof成功后设置最终owner cwd；source-filtered internal catalog可保持无attribution。A2UI与unqualified permission保持明确primary-bound。测试同时覆盖legacy与workspace-qualified获准internal操作得到internal hash、proof失败/未知owner不产生hash，以及任何internal candidate都不先污染primary attribution。
- [ ] capabilities feature predicates逐项分类：owner-routed generation与process/per-runtime admission limits保留internal；internal alone不触发`multi_workspace_sessions`、workspace-qualified ACP/voice/memory或scratch registration。每个变化都对应实际普通selector/registration表面，不能blanket-filter。
- [ ] health aggregate保持可用；capabilities仅把active/current internal按固化scope展示为兼容`kind: "live"`，transitioning/blocked/draining internal不退化成普通entry，removed internal按registry契约不再展示，limits仍反映实际runtime；ordinary selector features无internal/standalone误广告。daemon status不在ordinary`workspaces[]`/path issue中暴露internal。
- [ ] trust reconciliation、Live task/projectless路径、realtime startup和 shutdown aggregate保留明确 internal行为，增加回归测试防止过度过滤。

### Task 7：收紧WebShell compatibility boundary

**Files:**

- Modify: `packages/web-shell/client/App.tsx`
- Modify: `packages/web-shell/client/App.test.tsx`
- Modify: `packages/web-shell/client/components/sidebar/WebShellSidebar.tsx`
- Modify: `packages/web-shell/client/components/sidebar/WebShellSidebar.workspace-removal.test.tsx`
- Modify: `packages/web-shell/client/voice/voice-workspace-target.ts`
- Modify: `packages/web-shell/client/voice/voice-workspace-target.test.ts`

- [ ] 从capabilities全量`workspaces`派生`ordinaryWorkspaces = kind !== "live"`；全量集合继续支持Live sidebar/catalog与已授权session identity，Composer、新session防御性校验、scheduled-task target及scratch outcome workspace展示必须使用ordinary集合。
- [ ] Live `WorkspaceSection`改为`sourceType={sourceMetadataEnabled ? 'default' : undefined}`，不再沿用`selectedSessionSource`；feature缺失的旧daemon保持unfiltered legacy请求。fixture同时在default/channel tab断言Live active query固定为default，并覆盖现有archived catalog的分页/query shape。
- [ ] voice target resolver对`kind: "live"`返回不可用，不能生成workspace-qualified ID/cwd URL；普通primary/secondary voice保持不变。
- [ ] 回归证明Live section及source-filtered catalog仍显示/可load，Live entry不再出现在新会话、scheduled-task或voice workspace selector；不增加Standalone文案、控件或capability。

### Task 8：验证、E2E 计划与审计

**Files:**

- Create: `.qwen/e2e-tests/standalone-pr1-runtime-boundary.md`（实现工作产物，不提交）
- Modify: `docs/developers/daemon/02-serve-runtime.md`
- Modify: `docs/developers/daemon/20-quickstart-operations.md`
- Update design doc仅当实现发现 contract必须修订；不为重复计划内容做无意义改写。

- [ ] 先跑所有 changed-file focused tests；从 `packages/cli` 目录执行 Vitest。
- [ ] 按仓库要求先用global`qwen` dry-run记录baseline：在隔离temp HOME/USERPROFILE中观察现有Live catalog/load请求形状、internal普通route当前可达性与正常shutdown行为，先断言所有root都落在temp tree；若global版本不含PR0 seam，明确标为不可比而不是伪造before。
- [ ] 运行 `npm run format`并重新审diff，再执行`npm run build && npm run typecheck`，随后`npm run lint`。
- [ ] build/bundle后执行two-daemon E2E：两个真实child daemon共享同一个隔离的temp HOME/USERPROFILE与stable base、各用不同primary workspace/port；覆盖owner contention时loser的ordinary workspace仍可用但无internal entry/locator且Live操作返回503、kill -9 stale reclaim（平台支持时）、Live locator compatibility、generic REST/ACP WS/Voice WS拒绝、正常shutdown handoff、无primary fallback。先断言record解析到temp tree，绝不触碰操作者真实`~/.qwen`。
- [ ] WebShell行为验证记录Before/After evidence：Before的`kind: "live"`会出现在Composer/voice或scheduled-task ordinary selector，After这些selector不再展示/生成其目标，同时Live sidebar section、source-filtered list与精确session load仍可用。
- [ ] 更新公开embed文档：`createServeApp`返回值保持不变；需要Live/Conversations的direct embed用`http.createServer(app)`绑定实际listener，调用`getServeAppLifecycle(app).bindServer(server)`，并以`await lifecycle.close()`完成shutdown。说明未绑定时internal能力fail closed、raw `server.close()`只触发event-driven best-effort cleanup且仍应await lifecycle，以及ordinary-only embed不受影响；给出从现有`app.listen()`示例迁移后的完整代码。
- [ ] 在macOS/Linux可用环境验证mode/uid/PID与rename-over replacement；Windows把POSIX mode/uid标为N/A，验证regular non-reparse/single-link、平台commit顺序，以及delete→commit失败由held-lock grace、crash gap由stale阈值覆盖后继handoff，再验证PID、nonce和path semantics；不写“atomic overwrite”伪保证。
- [ ] 检查 `git diff --check`、production/test line count和 PR template证据；PR1仍不广告 capability。
- [ ] 按仓库规则做开放式自审；发现问题即修订并重跑验证，直到连续两轮 clean pass。

## Focused verification commands

```bash
cd packages/cli
npx vitest run src/serve/conversations/conversation-runtime-ownership.test.ts
npx vitest run src/serve/conversations/conversation-runtime-activity.test.ts
npx vitest run src/serve/conversations/conversation-runtime-manager.test.ts
npx vitest run src/serve/live/discovery.test.ts
npx vitest run src/serve/live/live-task-service.test.ts
npx vitest run src/serve/live/realtime-startup-context.test.ts
npx vitest run src/serve/live/run-qwen-serve-live.test.ts
npx vitest run src/serve/routes/live.test.ts
npx vitest run src/serve/workspace-registry.test.ts
npx vitest run src/serve/workspace-route-runtime.test.ts
npx vitest run src/serve/acp-http/workspace-qualified-acp.test.ts
npx vitest run src/serve/routes/workspace-qualified-voice.test.ts
npx vitest run src/serve/routes/workspace-qualified-extensions.test.ts
npx vitest run src/serve/routes/workspace-management.test.ts
npx vitest run src/serve/multi-workspace-sessions.test.ts
npx vitest run src/serve/routes/channel-notify.test.ts
npx vitest run src/serve/routes/workspace-channel-management.test.ts
npx vitest run src/serve/routes/workspace-channel-observed-contacts.test.ts
npx vitest run src/serve/routes/scheduled-tasks.test.ts
npx vitest run src/serve/routes/session-runtime.test.ts
npx vitest run src/serve/routes/workspace-trust.test.ts
npx vitest run src/serve/server/telemetry.test.ts
npx vitest run src/serve/server/session-archive.test.ts
npx vitest run src/serve/daemon-status.test.ts
npx vitest run src/serve/serve-app-lifecycle.test.ts
npx vitest run src/serve/server.test.ts
npx vitest run src/serve/run-qwen-serve.test.ts
npx vitest run src/serve/workspace-trust-reconciler.test.ts

cd ../web-shell
npx vitest run --config vitest.config.ts App.test.tsx
npx vitest run --config vitest.config.ts components/sidebar/WebShellSidebar.workspace-removal.test.tsx
npx vitest run --config vitest.config.ts voice/voice-workspace-target.test.ts

cd ../..
npm run format
npm run build
npm run bundle
npm run typecheck
npm run lint
git diff --check
```

本地迭代可临时加`-t`；上面的交付命令必须运行完整test file，避免regex遗漏新增用例。

## Explicit non-goals

- 不创建 `StandaloneSessionService`，不新增/迁移 transcript source。
- 不添加 standalone REST、SDK、WebUI/WebShell feature或 capability；仅做上述既有`kind: "live"` entry的ordinary-selector过滤与Live catalog source-filter兼容，不改变Live catalog UX。
- 不承诺 old daemon在 new owner之后启动时的 mixed-version互斥。
- 不引入 daemon-to-daemon proxy、multi-master lease、heartbeat、TTL或网络协调。
- 不改变`createServeApp`返回类型，不新增与`RunHandle`平行的第二套ownership lifecycle；只导出一个由direct embed和`runQwenServe`共同使用的listener-bound handle/accessor。
- 不把 Conversations 变成严格 OS sandbox；保留现有 user/global/root config语义。
- 不重构整个 registry；一个 predicate、default-deny resolver和逐 consumer guard已足够。
- 不改变 broad parent workspace的文件 containment模型，不在 PR1扩大到通用 filesystem policy。

## Exit criteria

- 两个新版本 daemon并发时，只有一个能 publish/use Conversations runtime；active/PID-reused/compromised owner均 fail closed。
- dead owner可在固定 grace后恢复；成功 shutdown在完整 drain和 listener确认后安全 handoff，drain/listener proof不完整时不进入owner unlink；exact unlink后的lock cleanup失败按明确post-unlink状态处理。
- `createServeApp` direct embed可通过公开共享lifecycle安全使用Live/Conversations：未绑定listener时零ownership I/O并fail closed，绑定后无论由handle还是外部server close发起shutdown都进入同一cleanup状态机，且公开await路径能证明drain与release结果。
- 所有 ordinary workspace HTTP、ACP WS、Voice WS、management和后台 consumer都无法通过 internal ID/cwd寻址该 runtime。
- owner-routed Live/session行为、health/capabilities兼容、总局 UUID admission、metrics与 shutdown保持工作。
- 没有任何 failure path回退到 primary runtime，且 `standalone_sessions_v1`仍未出现。
