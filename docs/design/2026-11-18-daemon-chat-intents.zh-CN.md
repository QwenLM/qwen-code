# Daemon 聊天适配器：意图生命周期（Slice 2b）

[English](2026-11-18-daemon-chat-intents.md) |
[简体中文](2026-11-18-daemon-chat-intents.zh-CN.md)

状态：已实现（slice 2b）。日期：2026-11-18。属于
[统一聊天界面](2026-11-16-unified-chat-surface.md)迁移的一部分。Slice 1
（#17520）已落地契约与纯 admission/outcome 助手；composer 解耦（#17661）与
共享状态栈抽取（#17684）均已合入。本切片落地 daemon 适配器的意图生命周期核心，
以及证明「admission 不等于 establishment」不变量的负向测试。

## 范围

daemon 适配器把 daemon 会话状态与动作转成后端中立的
`SessionChatController`。它的新逻辑不在 transcript 或子控制器——那些在下一步
从现有 provider 组装——而在**意图生命周期**：submit、cancel、approval、question
如何报告 admission 与 outcome，且绝不把一次已 resolve 的 transport 调用与一个
已建立的效果混为一谈。

本切片以一个小的、依赖注入的引擎 `createDaemonChatIntents` 交付该生命周期，
并随附父设计要求随 daemon 适配器落地的三个负向测试（延迟的 turn 结果、未决的
cancel、被取代的 approval），以及一条见证关联测试，使每份证据只作用于它所结算
的那次尝试。把引擎接到真实 `DaemonSessionProvider` 的动作与证据、
并组装控制器界面的其余部分（messages、待处理审批/提问、能力门控的子控制器），
是紧随其后的一步（slice 2c），该步把主列切换到 `ChatSurface`。本切片不改动任何
现有 UI。

## 不变量重述

契约区分了两个会被单一「completed」标签混淆的事实：

- **Admission**——请求是否被后端接受（`accepted`、`rejected`、`unknown`）。这是
  transport 调用所报告的。
- **Outcome**——是否有权威证据表明预期效果已建立（`established`、`unsettled`、
  `failed`）。这只能来自见证（witness）：turn 结束、取消结算、作用于仍当前请求的
  决定。

一个已 resolve 的 promise 是 admission，绝不是 establishment。Slice 1 已把真值表
（`resolveOutcome`）与操作保留/phase 派生钉为纯函数。本切片钉住**喂给它们的生命
周期**：引擎必须从证据而非 transport promise 取得 witness。

## 设计

`createDaemonChatIntents()` 返回一个跟踪器，含：

- `dispatch(kind, target, transport)`——先铸造操作 id、对 target 取**冻结快照**
  （调用方保留并改写其对象也无法事后重定向已记录的尝试）、并在执行 transport
  **之前**把该尝试记为 `pending`，使请求在飞时该行已存在（证据可绑定到它），且各
  行保持派发顺序。随后导出 admission（`accepted`/`rejected`；抛错的 transport 记为
  `unknown`），返回 `{ operationId, result }`。该操作 id 就是结算证据必须点名的
  身份。尚无证据时 outcome 以 witness `none` 解析，故已准入的意图保持 `unsettled`；
  POST 在飞期间到达的证据被保留，并在 admission 解析后应用。`rejected` 准入不携带
  outcome 并移除该行，故结算其 id 是空操作。
- `settle(operationId, witness)`——把权威证据只作用于该 id 所标识的那次尝试，并
  重算其 outcome。未知或已终态的 id 是空操作，因此证据无法结算它并非为之下发的
  尝试，已结束的尝试也绝不被再次结算。对 approval，**settled** 决定仅在其请求仍
  存活时才建立：若记录下来的 `target.requestId` 缺失或不在存活集合内，正向 witness
  被强制为 `none`，该决定不建立。否定证据不被改写，故确实失败的被取代决定仍终态化
  为 `failed`。approval 一旦结算为 `established`，引擎即释放其请求身份——在唯一的
  证据应用路径中执行，故在飞证据路径同样释放——使存活集合不随每个被应答的请求增长。
  `failed` 决定不构成取代：其请求保持存活，重试仍可建立。
- `settleDecisionRequest(requestId, witness)`——把决策证据作用于该请求的存活
  （非终态）approval/question 尝试，复用与 `settle` 相同的结算核心。它存在是因为
  daemon 决策事件只点名请求、且可能在该尝试的 POST 仍在飞（操作 id 尚未绑定）时到达：
  它在证据到达时冻结 approval 时效，并暂存已收窄见证待 dispatch 应用。关联是请求级；
  无匹配的存活尝试即空操作，故已结束尝试的迟到事件不被保留。slice 2c 新增。
- `abandon(operationId)`——给 admission 永远无法被确认的尝试（抛错的 transport 留
  下 `unknown`，任何 witness 都无法使其终态化）一条出路：把该行终态化为 `failed`、
  绝不 `established`，使失败的 transport 不会把 phase 钉死。未知 id、已终态尝试、
  以及 admission 已被确认的尝试都是空操作——存活的已准入 turn 仍保留其结算机会。
- `acknowledge(operationId)`——在界面消费完一条终态行后释放它（委托 slice 1
  `acknowledgeOperation`）；非终态行保留，终态行在被确认前保持可读。每次 rebuild
  会从内部日志裁剪被取代的终态行，故确认最新终态行不会让旧行复现。
- `setApprovalRequestLive(requestId, live)`——跟踪仍**有效（未被取代）**的 approval
  请求集合。daemon 同时保留多个待处理授权请求，故时效是「在该集合内」，而非单一
  「最新」id。请求到达时标为存活，仅在被取代或取消时标为不存活——**而非在被应答
  时**；引擎在结算时自行释放身份，故决定在其请求未被取代期间即可建立。
- `operations`——保留后的操作列表（slice 1 `retainOperations`：每个非终态条目，
  每个 kind+target 至多一个最新终态，按派发顺序取最新）。快照在每次状态变化时物化
  一次，故其身份在变化之间稳定，可支撑 `useSyncExternalStore` 缓存。
- `phase(settled)`——slice 1 `deriveChatPhase`；一个未建立的 cancel 操作产生
  `cancelling`，与 cancel promise 是否 resolve 无关。

引擎只导入 `chat-core` 的契约类型与助手。它不导入 daemon 运行时，也不导入
`@qwen-code/sdk/daemon`，因此无需 daemon 即可测试，并按父设计的适配器放置原则
作为 daemon 适配器核心位于内核之外。其形式是后端中立的；managed 适配器（slice 3）
拥有自己的 receipts/revisions 映射，届时可通过把该生命周期提升进内核来共享，
而不是导入 `daemon/**`。

### 为什么单独设 `settle` 入口

若 `dispatch` 从 transport promise 的 resolve 导出 witness，那么一个快速或被 mock
的 transport 就会伪装成已建立的效果。把结算入口（按操作 id 的 `settle`、以及为在飞
决策证据按请求的 `settleDecisionRequest`）作为唯一能提升 witness 的路径，使该不变量
成为结构性的：transport 路径在字面上就无法产生 `established`。下面的负向测试在这一
边界被折叠时转红。

### 为什么结算要点名具体尝试

只有当 witness 属于它所建立的那次尝试时，它才算认证了 outcome——状态本身正确与
证据来源可信是两个独立条件。仅按 kind 加可见 target 匹配证据并不够：同一
session/turn 上的重试会复用该 target，于是已结束尝试的迟到 witness 会提升重试，
两份乱序到达的 witness 也会互换尝试。因此 `dispatch` 返回操作 id，`settle` 要求
提供它，引擎只能提升被点名的那次尝试的 witness，而结算已终态尝试是空操作。

引擎事后自行发明的 id 本身不认证任何东西：slice 2c 必须在发起请求时把操作 id
记在请求的后端身份旁，使到来的事件能点名它所属的尝试。适配器无法绑定的证据保持
未验证，而不是宣告新尝试已完成。

尝试在 transport 执行**之前**就被记录，原因有二。其一，各行按派发顺序排列，而
保留逻辑按位置取每个 kind+target 的最新终态行——当同一 target 上两次发送重叠时，
留下的是较晚**派发**的尝试，而非较晚**解析**的尝试。其二，请求在飞时该行（连同其
id）已存在，phase 读作 `submitting`，POST 期间到达的证据也有 id 可绑定。

### 时效是集合，失败的 transport 有出路

单一「当前请求」槽位混淆了两个问题——哪个请求最新、这个决定是否仍适用——而
daemon 同时保留至多 64 个待处理授权请求。在 `r2` 也在等待时批准仍待处理的 `r1`，
是后端确实应用的决定，必须建立；因此时效是「在存活请求集合内」，于 `settle` 时
判定。守卫只收窄正向证据，故确实失败的被取代决定仍终态化，而不是泄漏一条永久的
`unsettled` 行。

「存活」指**未被取代**，而非「仍在等待决定」：一个正在被结算的决定按定义已不再
等待，若在被应答时清除时效，会让所有 approval 都 `unsettled`。调用方在请求到达时
标为存活、仅在被取代/取消时标为不存活；引擎在决定结算为 `established` 时自行释放
身份（在共享的证据应用路径中，故经保留的在飞证据建立也释放），既保证「先应答后
结算」的自然顺序正确，又使集合有界。`failed` 决定不构成取代，其身份保持存活、重试
仍可建立。记录的 target 是冻结快照，调用方改写其传入的对象也无法把已派发尝试重定向
到存活请求、复活被取代的决定。

抛错的 transport 留下 admission `unknown`，真值表使其在任何 witness 下都保持
`unsettled`；若无出路，它会在引擎整个生命周期内把 phase 钉死。`abandon` 把这种
尝试终态化为 `failed`（绝不 `established`）。它拒绝 admission 已确认的尝试，故不会
杀死存活 turn。POST 仍在飞时，已持有的 `settled` 证据也会阻止 abandon，因为它可能
落在 accepted admission 上；但一旦 admission 解析为 `unknown`（transport 抛错），
持有的见证永远无法认证，该尝试必须保持可 abandon——否则先于失败 POST 到达的 turn-end
事件会把 phase 永久钉死。没有 settled 证据的在飞尝试可被 abandon，迟到的 accepted
响应随之被丢弃（迟到的 `rejected` 响应仍删除该行，因为被拒请求绝不进入 operations）。
被弃尝试打上标记，迟到的 transport 响应无法复活其终态。被取代的 approval 决定（正向
见证被强制为 `none`）获得终态 `failed` 出口，避免泄漏永久非终态行，而其返回 outcome
仍为 `unsettled`、绝不认证。superseded 标志在每次「尚未终态」的 settle 时重算，故重新
判定请求存活的重投递决定会把被取代的行升级，所发布的行状态与其 outcome 一致并释放
身份；一旦被取代的行已终态化为 `failed` 即为最终态（已终态的尝试绝不再结算）。冻结在
安全方向上单调：后续被判为取代的重复投递不能削弱已有效结算的行（`settled` 见证、未被
取代），而升级（被取代→存活）仍适用。

保留**按 kind 与 target 有界**——至多最新一条终态——终态行由 `acknowledge` 释放，
而非跨不同 target 自动释放：slice-2c 界面必须对每个已消费的终态行调用 acknowledge，
否则 `operations` 会按每个不同 turn／已应答 approval 各增一行。每次 rebuild 从内部
日志裁剪同一 kind 与 target 下被取代的终态行，故确认最新终态行不会让旧行复现。

## 负向测试（随 daemon 适配器落地）

1. **延迟的 turn 结果。** `dispatch('submit', …)` 配以 resolve 为 `accepted` 的
   transport，得到 `unsettled`，phase 为 `running`。只有
   `settle(operationId, 'settled')` 才产生 `established` 并使 phase 回到 `idle`。
2. **未决的 cancel。** `dispatch('cancel', …)` resolve 为 `accepted` 仍保持 phase
   `cancelling`；已 resolve 的 cancel promise 并不结束它。只有结算证据才建立 cancel
   并清除 `cancelling`。
3. **被取代的 approval。** `r1` 存活时，一个在 `r1` 离开存活集合后才被确认的 `r1`
   approval 决定，正向证据下绝不建立；仍存活的 `r2` 决定则可以（正向对照）。承载
   不了请求身份的 approval 同样绝不建立。被报为 `failed` 的被取代决定仍终态化为
   `failed`。
4. **并发 approval。** `r1` 与 `r2` 都存活时，分别结算两个决定都建立——单一「当前」
   槽位会把第二个误报为 `unsettled`。
5. **见证关联。** 尝试 A 结算为 `failed` 后，A 的迟到见证绝不能建立同一可见 target
   上的重试 B；B 自己的见证则可以。同一组两份见证无论以何种到达顺序应用，结果都
   是 A `failed`、B `established`。已 `established` 的尝试再被结算 `failed` 是空操作，
   仍保持 `established`。
6. **派发顺序与在飞身份。** transport 解析前已存在 pending 行、phase 为
   `submitting`；同一 target 上一慢一快两次发送重叠时，保留留下第二次（较晚派发）
   尝试。
7. **unknown admission 有出路。** 抛错的 submit/cancel transport 会钉死 phase，直到
   `abandon` 将其终态化，之后 phase 为 `idle`；`abandon` 绝不建立，对已终态/未知 id
   以及已确认 admission 是空操作。
8. **记录 target 不可变。** 调用方在派发后改写其传入的 target 对象，无法把尝试重定向
   到存活请求：被取代决定保持 `unsettled`，该行仍声称派发时的身份。
9. **在飞证据不被丢弃。** transport 在飞期间送达的结算，在 admission 解析后被应用，
   建立该尝试并清除 phase，无需重投。
10. **abandon 不能杀死存活 turn；抛错的 transport 保持可 abandon。** 对 admission
    已确认的尝试，`abandon` 是空操作——其证据仍会落地并建立。POST 在飞时，已持有的
    `settled` 证据会阻止 abandon，因为它可能落在 accepted admission 上；但对
    `unknown` admission（transport 抛错），持有的见证永远无法建立，该尝试必须保持
    可 abandon，否则 phase 被钉死。没有 settled 证据的在飞尝试可被 abandon，迟到的
    accepted 响应被丢弃。
11. **先应答后结算的顺序。** approval 在其请求存活时结算为 `established`，尽管应答
    意味着它已不再等待决定；引擎在结算时释放身份，故对同一已结算请求重投的决定不再
    建立。
12. **确认重试不会复活被取代的失败。** 同一 target 上首次 submit 结算 `failed`、重试
    结算 `established` 后，确认重试使 `operations` 为空——被裁剪的旧失败不再出现。
13. **迟到响应不能复活已弃 cancel。** 在 cancel 的 POST 在飞时 abandon 使其终态化；
    随后 transport resolve 为 `accepted`，该行仍 `failed`、phase 仍 `idle`，后续 settle
    是空操作。
14. **失败决定后的重试仍可建立。** 决定结算 `failed` 不构成对其请求的取代；同一仍存活
    请求的重试可建立（仅在 `established` 时释放）。
15. **在飞建立也释放身份。** 经保留的在飞证据建立的 approval 释放其请求身份，故对同一
    请求重投的决定不再建立。
16. **被取代决定获得终态出口。** 被取代 approval——以及不带请求身份派发的 approval——
    结算为 `unsettled`，但该行终态化为 `failed`，故 `acknowledge` 可释放它，而非泄漏
    永久非终态行。
17. **在飞被弃后 rejected 不跟踪。** 在飞时 abandon、随后 resolve `rejected` 会删除该行
    （被拒请求绝不进入 operations）。
18. **在飞时效于 settle 时冻结。** 被取代时结算的决定，即使其请求在 admission 前重新
    存活也不建立；存活时结算的决定，即使其请求在 admission 前被取代仍建立。
19. **pending submit 在 admission 前保持 submitting。** 对 pending submit 的在飞证据
    只保留见证、不离开 `pending`/`submitting`；dispatch 在 admission 解析后应用。
20. **`phase('failed')` 透传。** settled-phase 参数不被硬编码为 `idle`。
21. **记录 target 冻结。** `Object.isFrozen(operations[i].target)` 为 true，且经其写入
    抛错，故暴露的行无法被重定向。
22. **在飞结算后抛错的 transport 保持可 abandon。** POST 在飞期间已有 turn-end 事件
    结算、随后抛错的 submit，其 admission 为 `unknown`；`abandon` 使其终态化、phase
    回到 `idle`（持有的见证永远无法认证 `unknown` admission）。
23. **重投递的在飞决定重算取代。** 把 pending approval 结算为被取代、标回请求存活、
    再结算一次，所发布的行状态与返回 outcome 一致并释放身份，故重投递不能再次建立。
24. **取代后的重复投递不削弱已有效结算的 pending approval。** 存活时结算 pending
    approval、随后取代并重投递同一决定，admission 解析后仍建立（单调 no-weaken 冻结）；
    去掉该守卫时重复投递会使其终态化为 `failed`。

配套用例钉住：rejected 准入（无 outcome、不跟踪，结算其 id 为空操作）、failed
witness、对未知 id settle（空操作）、按 kind 与 target 有界保留、状态变化之间
`operations` 快照身份稳定、以及 `acknowledge` 释放已消费的终态行而保留其他行与非终态行。

变异见证（可通过编辑引擎并从 `packages/web-shell` 运行
`npx vitest run client/daemon/chat-intents.test.ts` 复现）：把 dispatch 的 witness
取自 transport（用 `'settled'` 而非 `'none'`）会令延迟 turn 与 cancel 用例转红；
把取代守卫扩到否定证据会令被取代失败用例转红；把存活集合塌缩为单槽会令并发
approval 用例转红；把记录移到 `await transport()` 之后会令派发顺序与在飞用例转红；
把 `abandon` 变为空操作会令出路用例转红；去掉终态守卫的 `established` 半会令重结算
用例转红；按 kind 加 target 而非操作 id 结算会令关联用例转红；按引用记录调用方
target 而非冻结快照会令记录 target 用例转红；忽略保留的在飞见证会令在飞证据用例
转红；去掉 `abandon` 的 `unknown` admission 守卫会令存活 turn 用例转红；去掉结算时
的时效释放会令先应答后结算用例转红；rebuild 时不裁剪被取代终态行会令确认重试用例
转红；去掉 `await transport()` 后的 abandoned 检查会令迟到响应用例转红；在任意终态
（含 `failed`）都释放身份会令失败后重试用例转红；把释放移出共享证据应用路径会令
在飞释放用例转红；去掉被取代终态出口会令被取代确认用例转红；去掉 abandoned 分支的
rejected 清理会令在飞被弃 rejected 用例转红；在证据应用时重新收窄见证（而非 settle
时冻结）会令存活时结算的在飞用例转红；对 pending 行应用在飞证据会令 pending submit
用例转红；去掉 `abandon` 的已持证据守卫会令已持证据用例转红；把该守卫放宽回任意已持
`settled` 见证（而非仅 pending 行）会令抛错可 abandon 用例转红；superseded 标志只置位
不重算会令重投递决定用例转红；把 superseded 标志收窄到带 requestId 的 target 会令
无身份 approval 终态断言转红；把 abandoned 迟到响应见证由 `failed` 改为 `none` 会令
返回 outcome 断言转红；去掉单调 no-weaken 冻结会令取代后重复投递用例转红；把 `phase`
硬编码为 `idle` 会令 failed-phase 用例转红；移除 `Object.freeze` 会令冻结 target 用例转红。

## 遵守的约束

- 不改 daemon 路由、Java 路由或 OpenAPI；不改 UI 行为。
- 引擎位于 `chat-core` 之外，既不导入 `daemon/**` 值代码也不导入
  `@qwen-code/sdk/daemon`；`chat-core` 不导入它。
- 幂等/receipt 语义不在本切片；managed 适配器在 slice 3 保留它们。

## 后续（slice 2c）

把 `DaemonSessionProvider` 动作包装为 transport、把 daemon 事件作为 `settle`
证据，并在派发时登记的操作 id 上绑定每个事件（显式对照表；无法绑定的事件保持
未验证），组装控制器界面（messages、待处理审批/提问、能力门控的子控制器），并以
视觉前后对比门把主 daemon 列切换到 `ChatSurface`。
