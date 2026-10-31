# 让被持有 Runtime 的 drain 义务跨重启存活（#13930 R1-2）

状态：设计。[English](2026-10-12-restart-proof-held-runtime-drain.md) 与中文双版同步。

## 1. 它解决什么问题

后台 run 按设计活过它的 turn：turn 的 routine release 被拒 `runtime_session_held`，turn 干净结算，run 继续持有它的 Runtime。Session 的 close 欠这个 Runtime 一次 drain——而这份义务只记在进程内的 `heldRuntimeTurns` 集合里。

现在重启 Harness（或让替换实例接管这个 Session）。重新加载的 Session 拿到的是 `heldRuntimeTurns: new Set()`，没有任何路径回填它：它的 `DELETE` 遍历一个空集合、答 204，而 worker 上的 run 还活着。Runtime 与它的 workspace mount 被继续钉住——而且是静默的，因为没有任何地方记录这次滞留——直到很晚的 workspace 级 `drainHarnessSession` 级联才兜住。

没有它时用户面对什么：他们要求保留的后台任务没事，但**他们关闭的那个 Session** 还钉着一个 Runtime 和一个 mount，而且任何地方都不说。

约束决定修法的形状：义务必须在加载时被**恢复**，绝不在加载时被**清偿**——加载即 drain-release 会停掉一个存活 Session 仍想保留的 run。

## 2. 设计决定与它躲开的故障

**在 Session 加载时，从 Broker 的持久 hold 行恢复这份义务集合。**

Broker 才是"什么仍被持有"的真相源：每个存活的后台 run 都有一行非终态的 hold 行，且每行都直接带 `harnessSessionId` 与 `runtimeSessionId`。所以与其新增一个持久标记、或给记录契约动手术，不如让重载直接问 Broker：这个 Session 名下哪些 Runtime Session 仍被持有——然后用答案回填 `heldRuntimeTurns`。close 照旧 drain 它们。

这躲开三个具体故障：

- **静默钉住（R1-2）。** 没有它，重启后的 Harness 的 close 对着一个还存活的 run 答 204，且没有任何地方记录这次滞留。
- **过急的停止。** 加载时只恢复（不清偿），意味着重新打开的存活 Session 保留它的 run；只有 close 才 drain。
- **记录契约手术。** `child_run`/`monitor_run` 记录体不带 runtime session 关联，而且是 TS 与 Java 双侧共享的"精确键数"闭键校验器——加字段会牵动两个校验器和全部 fixtures；只读的 Broker 查询两者都不碰。

## 3. 机制（参考手册）

### Broker（Java，`runtime-broker`）

- 一个只读的 service 方法 `listActiveHoldRuntimeSessionIds(harnessSessionId)`：这个 Harness Session 名下仍欠 close 排空的 Runtime Session id。hold 行是带 `background_v3_*` dispatchMode 的执行记录；只要其 Runtime Session 的释放没有持久落账，该行就算数——hold 行进入终态（run 退出、watch 停止）本身并不清偿（#13986 评审）。
- 一个仓储查询 `findHoldRowsByHarnessSession`（InMemory + Jdbc + `JdbcRepositoryContract` 对等钉），因为行上直接带 `harnessSessionId`；释放状态过滤在 service 层、按 `RuntimeSessionRecord` 判定；精确的 Harness 归属在 Java 侧复核，因为该列的排序规则可能不区分大小写（#13986 评审）。
- 一条只读路由。它读持久行，所以 Broker 重启后也能答。

### Harness（CLI，`hosted-harness-session.ts`）

- 一个客户端方法，按本 Session 的 harness id 调那条路由。
- Session 加载（重开既有 Session）时调用它，把返回的 id 回填进 `heldRuntimeTurns`——恢复，绝不清偿。全新创建的 Session 没有 hold 行，集合保持为空；查询失败的加载记一条日志、不带义务地加载（不比今天更糟）。

### Close

close 用 `release({ drain: true })` drain `heldRuntimeTurns`，容忍精确的 404、对任何未证明的拒绝诚实 park。评审后（#13986 R2-1）容忍面扩大了一处：与 Harness 一同重启的 Broker 无法证明释放，会答它声明为可重试的 503 `runtime_reconciliation_required`，Runtime 由 Workspace 级联接管。close 也容忍这个回答——否则该 Session 永远无法退役——同时未证明的 drain 仍让 monitor loop 停在 `runtime_lost`，绝不报 `stop_requested`。

## 4. 验收

在 `hosted-harness-session.test.ts` 的 `drains a turn-held Runtime at close through the drain arm (#13856)` 旁加一个 takeover 用例：一个被预写并关闭、从未经历过 close 排空的 Session（死去的进程），其被持有的 Runtime Session 仍被 Broker 列出；全新进程加载它并在那里 DELETE；替换进程的 `release` 必须对该被持有 Runtime Session id 带 `[{ drain: true }]` 被调用。不做加载时恢复，这条断言是红的。

测试预写 journal，而不是先在存活的原进程上跑出那个被持有的 turn：writer 租约会拒绝同一进程内对一个存活 Session 的第二次打开，单测试进程内摆不出双进程形态——也不需要，因为恢复信任的是 Broker 的持久 hold 行，而非 journal 的 turn 记录。routine 拒绝 → 持有 → close 排空那一半，由旁边的 #13856 用例覆盖。

## 5. 边界

- 只管 direct Harness API 路径。control-plane 的 Session close 有自己的 `drainHarnessSession` 兜底，不在本切片内。
- lifecycle-v2 Session 的直接 close 永不执行 drain 块，因此其加载完全跳过恢复——该集合唯一的读取点位于仅限 v1 的 close 块内（#13986 评审）。
- 评审波次推迟的 28 条 Suggestion 是另一批卫生工作（#13930 跟踪）；本切片只做 R1-2。
