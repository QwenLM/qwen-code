# JSONL 尾部诊断：受限恢复、驱逐策略与生命周期见证

[English](./jsonl-tail-diagnostics-17852.md) | [简体中文](./jsonl-tail-diagnostics-17852.zh-CN.md)

**状态：已合入。** 随
[#17901](https://github.com/QwenLM/qwen-code/pull/17901) 落地，squash 提交
`78411506df6734efd2fcf7e627ab1b27098afd77`，合入日期 `2026-11-20`。这是已合入的
追加完整性修复 #17771 的后续工作，解决跟踪 issue #17852 的事项 1–3。事项 4
（Windows 原生与当前 head 的 macOS 验证）**未**解决，仍在 #17852 中开放，见
[范围边界](#范围边界)。

下文的验证计划已按原样执行。其结果——已确认的 280 条告警更替基线及其 128 条的
改动后结果、聚焦套件 150 → 171 的计数、11 行变异矩阵及其一行有意存活的归因、
以及仅 Linux 的原生 FIFO 证据——记录在
[验证报告](https://github.com/QwenLM/qwen-code/pull/17901#issuecomment-7029094987)
与
[跟踪 issue 上的落地说明](https://github.com/QwenLM/qwen-code/issues/17852#issuecomment-7032035092)
中。

## 问题陈述

`packages/core/src/utils/jsonl-utils.ts` 中的 `writeLine` / `writeLineSync`
在 regular file 尾部无法检查时仍能安全追加，并通过一条限频的 debug 告警报告该回退。
正确性修复已随 #17771 落地。三个诊断与覆盖缺口被延后到 #17852：

1. **修好的 sink 仍然沉默。** `reportUninspectableTail` 给每个
   `(filePath, debugLogPath)` 键三次投递机会。第三次失败后，只要该键仍在缓存中就被抑制。
   修复 debug sink 无法产生新的投递尝试，于是诊断恰好在它本该重新可用时消失。
2. **缓存更替无策略地重复告警。** 诊断集合最多保存
   `MAX_DIAGNOSED_TAIL_READ_FAILURES = 128` 个键，并驱逐最旧的键来接纳新键。
   驱逐一个已投递告警的键会丢掉它的抑制状态，因此一长串不同路径每轮都会重新告警。
   另外，来自描述符操作（`FileHandle.read`、`FileHandle.stat`、`fstatSync`）的
   致命尾部检查错误不带文件路径，因为 Node 只给基于路径名的系统调用附加 `path`。
3. **生命周期与 delivery 见证不完整。** 显式 writer 的 `sync()` / `close()` 路径、
   过期完成守卫、FIFO 的 writer 句柄目标，以及真实 debug append 失败叠加 delivery
   observer 抛错，都没有聚焦断言。

### 已确认的基线

两个行为缺口都在未修改的 `main`（`1176e39bbc036d60c6754ae5976bf2703001b43c`，
即 #17853 账本提交）上复现，环境为 Linux x86-64、Node `v26.12.1`，使用源码级探针
（`.qwen/scripts/17852/repro-baseline.ts`，本地工作产物），以 `EACCES` 拒绝
`O_RDONLY | O_NONBLOCK` 尾部探测：

| 场景       | 触发条件                                                                                           | 本次改动前观察到的结果                                                                                  |
| ---------- | -------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| 缓存更替   | 140 个不同的残缺路径、2 轮追加、健康 sink                                                          | **280 次追加 → 280 条告警**                                                                             |
| 故障后恢复 | 单路径，runtime 目录被换成普通文件，追加 6 次；随后恢复目录并用 marker 证明 sink 健康，再追加 4 次 | **故障期间 0 条告警，恢复后仍 0 条**；`isDebugLoggingDegraded()` 为 true；10 条记录全部以保守分隔符追加 |

缓存更替的结果独立确认了 #17852 引用的例子——跟踪 issue 明确把它列为未确认线索。
恢复场景的结果确认了仅修复 sink 不会重新启用投递。两个场景都没有丢失或改写已有字节：
追加路径全程保持正确。

## 目标

- 让修好的 sink 能重新投递尾部诊断，同时不造成告警洪水，也不在日志禁用时新增副作用。
- 给 128 键上限一个清晰、有文档的与按目标抑制的交互规则，使更替不会变成无界告警流。
- 让致命的尾部检查错误指出它失败于哪个文件，同时不改变错误的身份、code 与追加结果。
- 为 writer 生命周期与 delivery 区分补充聚焦见证，每条都配对照或变异，显示守卫的价值。

## 非目标

见[范围边界](#范围边界)。

## 提议的改动

### 1. 投递预算耗尽后的受限重试冷却

`TailDiagnosticEntry` 新增一个字段 `retryAfter: number`（epoch 毫秒，
初始预算尚未用完时为 `0`）。

- 第 1–3 次尝试与今天完全一致：每次追加尝试一次，直到投递成功（`retained`）
  或预算用尽。
- 当某次尝试使 `attempts` 达到 `MAX_TAIL_DIAGNOSTIC_DELIVERY_ATTEMPTS` 时，
  该条目设置 `retryAfter = Date.now() + TAIL_DIAGNOSTIC_RETRY_COOLDOWN_MS`。
- 之后对已耗尽键的调用在 `Date.now() < retryAfter` 期间被抑制。窗口结束后，
  **只放行一次**探测尝试：条目把 `attempts` 保持在上限、为整个窗口重新设置
  `retryAfter`，并把自己标记为 `pending`。投递成功会设置 `retained` 并结束该键的
  所有后续尝试；失败则让该键再被抑制一个完整窗口。

`TAIL_DIAGNOSTIC_RETRY_COOLDOWN_MS = 60_000` 与
`packages/core/src/services/tokenUsageService.ts` 中既有的
`TOKEN_USAGE_FAILURE_LOG_COOLDOWN_MS` 先例一致，让仓库对尽力而为的本地写入诊断
保持同一个冷却量级。

尝试计数器永不清零。这是 #17853 账本记录的设计约束：达到上限后直接重置，
会对一个永久损坏的 sink 重新打开无界重试循环。

### 2. 驱逐只回收投递已失败的槽位

缓存已满时的接纳规则从「删除最旧的键」改为：

- 删除最旧的**投递已结算且失败**（既非 `retained` 也非 `pending`）的键，
  然后接纳新键；
- 如果不存在这样的槽位，**既不驱逐也不接纳**。追加仍以保守分隔符正常进行，
  只是跳过诊断。

`retained` 槽位拥有一条已投递的抑制，`pending` 槽位拥有一条在飞的抑制。
两者都保护，使上限与投递时序无关：在任何投递结算之前就接纳 129 个不同路径的
突发，仍然最多产生 128 条告警。只保护 `retained` 经实测是不够的——同步突发
会驱逐在飞条目，129 个路径仍产生 129 条告警。

由此得到的不变量：同时最多 128 个键持有抑制，且槽位只在其投递失败后才被回收，
因此已落盘（或即将落盘）的告警不会失去它的抑制。在已确认的更替场景下，告警数
从 280 降到 128，第二轮不再新增。

被回收的槽位也会失去它的冷却状态：若同一键之后再次被接纳，它会重新开始一个
三次尝试预算。这是有意为之——该槽位被回收正是因为它的投递失败了，而损坏 sink
在更替下仍然不会落盘任何告警。这一点与既有驱逐行为一致，未改变。

由于在飞条目不再可被驱逐，过期完成守卫现在是纵深防御，而不是可达的生产竞态。
它的见证通过 `_resetEnsuredDirsCacheForTest()` 驱动——这是条目在投递仍在飞时
被替换的剩余途径。

实测注记：单独删除那行守卫**不会**改变可观察行为。delivery 回调闭包捕获的是
它自己的 `entry` 对象，因此过期完成改动的是一个集合已不再持有的孤儿对象。
所以该见证钉住的是隔离性质，其锋利用于把「写闭包对象」换成「写集合当前持有
的对象」——那个变异会让见证失败。保留守卫是为了显式陈述该不变量，而不是因为
它是强制该不变量的机制。

### 3. 致命尾部检查错误的文件上下文

当 `canAppendWithoutTailInspection` 返回 false 时，catch 块在原始错误的 message
后追加 ` (file: <filePath>)` 再抛出，且仅当 message 尚未包含该路径时才追加。
基于路径名的 Node 错误本来就带文件名，保持不变。

该标注同样覆盖 `ENOENT` 恢复分支。它自己的 `open` 与描述符 `stat` 运行在 catch
**内部**，因此那里的失败原本会不带标注地逃逸——这与非 regular 分支不同，后者的
`stat` 在 try 中运行，失败会落进 catch。两个 appender 都把恢复块包起来，经同一个
助手重抛。

错误对象被就地标注而非包装：调用方会匹配原始对象及其 `code`（例如
`chatRecordingService` 把该错误存为粘滞的写入失败，`tokenUsageService` 打印
`error.message` 并按 `code` 限频）。包装会改变身份，并可能丢掉这些消费方读取的
`code`。原始 message 仍是逐字前缀，stack 不变，追加结果也不变——错误继续传播，
不会发生回退追加。

### 4. 生命周期与 delivery 见证

新增聚焦测试，与既有套件同目录：

- **显式 writer 生命周期。** 对 `ENOENT` 新建的文件与非 regular 路径，异步追加
  收到的是已打开的 `FileHandle`（而非路径名），在其上调用 `sync()` 并关闭它。
  `sync()` 被拒绝时错误传播且句柄仍被关闭；健康可读的 regular file 保持
  `openAppender === undefined`，因此不会执行额外的 `sync()`/`close()`。
  同步变体通过其描述符断言同样的事实。
- **过期完成。** 一个 pending 条目被测试专用的缓存重置变成孤儿，该键被重新
  接纳，随后那条孤儿投递失败。更新的条目必须保持 `pending`、不得被标记为
  retained；它自己的投递恰好产生一条告警。
- **FIFO writer 目标。** 追加参数是以 `'a'` 打开的句柄，且该句柄在追加失败后
  被关闭。「未打开探测」仍由既有的 `does not open a FIFO just to inspect its
tail` 见证钉住，而不是由本用例钉住。
- **append 失败叠加 observer 抛错。** `fs.appendFile` 被拒绝且 delivery observer
  抛错：`isDebugLoggingDegraded()` 保持 true，delivery 恰好被报告一次 `false`，
  observer 的异常不外泄。既有的反向对照（append 成功、observer 抛错、degraded
  保持 false）保留。
- **冷却与驱逐策略。** 故障 → 同路径恢复，在窗口结束后恰好投递一条告警；
  未恢复的 sink 每个窗口最多放行一次尝试；全是已投递条目的缓存不接纳新键；
  全是失败条目的缓存仍会驱逐以接纳一个。

## 设计决策与理由

| 决策                                                 | 理由                                                                                     | 被否决的替代方案                                                                                                                                            |
| ---------------------------------------------------- | ---------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 耗尽后每个冷却窗口只放行一次探测尝试，计数器永不重置 | 把损坏 sink 限制为每键每分钟一次尝试，同时让修好的 sink 能重新发声                       | 达到上限后清零 `attempts`（无界重试循环）；永久抑制（已确认的事项 1 缺口）                                                                                  |
| 冷却 `60_000` 毫秒                                   | 与既有 token-usage 写入失败冷却同量级；一个先例，不新增调参面                            | 新的任意间隔                                                                                                                                                |
| 只回收投递已失败的槽位；没有可回收槽位时跳过接纳     | 同时保住内存上限与每一条抑制（已投递或在飞），不新增状态、不新增定时器，且与投递时序无关 | 只保护 `retained`（实测不够：同步突发仍会重复告警）；第二套按 sink 的聚合预算（两套机制、又一个要调的上限）；完全不驱逐（损坏 sink 会永久堵死后续所有诊断） |
| 就地标注原始错误的 message                           | 为匹配身份与 `code` 的消费方保留身份、code 与 stack；路径名错误本来就带路径              | 用 `cause` 包装（改变身份，可能丢 `code`）；只加 `path` 属性（消费方打印 `message`，上下文仍不可见）                                                        |
| 旧 logger 回退保持至多一次                           | 没有 `warnWithDelivery` 的 logger 无法报告投递，冷却没有可依据的信号                     | 对旧 logger 也套用冷却                                                                                                                                      |

## 涉及文件

| 文件                                                        | 改动                                                                                           |
| ----------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `packages/core/src/utils/jsonl-utils.ts`                    | `retryAfter` 字段与冷却常量；驱逐规则；致命错误的文件上下文                                    |
| `packages/core/src/utils/jsonl-utils.test.ts`               | 冷却、驱逐策略、过期完成、writer 生命周期、FIFO 目标与错误上下文见证；旧的驱逐期望被新策略取代 |
| `packages/core/src/utils/debugLogger.test.ts`               | append 失败叠加 observer 抛错的见证                                                            |
| `docs/design/jsonl-tail-diagnostics-17852.md` / `.zh-CN.md` | 本设计文档                                                                                     |

不改动任何公开 API、配置键、CLI flag 或磁盘记录格式。

## 约束

- 日志禁用与会话被抑制的路径不得解析 debug session。
  `canAppendWithoutTailInspection` 中既有的门仍位于
  `getActiveDebugSessionLogPath()` 之前，冷却不新增任何查找。
- 普通新文件、空文件、正常换行结尾文件与残缺 regular file 保留预期字节。
  真实的 append、`fsync` 与 close 失败继续传播。
- 诊断集合仍限制为 128 键；冷却每条目只增加一个数字，不新增集合。
- delivery observer 抛错永不被当成文件系统 append 失败，失败的 append 也永不
  被报告为已投递。

## 风险

- **对已断言契约的行为变更。** 既有用例
  `warns again for an evicted path after exceeding the cache bound` 编码了旧的
  重复告警行为。它被替换而非削弱：新用例断言新策略下的精确告警数，另有一条用例
  保持未投递条目的驱逐可观察。
- **后续路径不再获得诊断。** 一旦 128 个键持有抑制，真正新出现的无法检查路径
  在某个槽位的投递失败之前不会被诊断。只有至少 128 个不同文件的尾部不可读时
  才可能到达该状态，这本身已是病态场景；追加本身不受影响。该取舍是有意为之，
  已在上文记录。
- **一个防御性守卫。** 过期完成守卫不再能经驱逐到达。保留它并用见证钉住，
  因为一旦将来驱逐重新回收在飞槽位，删掉它会静默地重新引入该竞态。
- **时钟依赖。** 冷却读取 `Date.now()`。测试用假定时器驱动而非 sleep，保持确定性。

## 验证计划

- 在 `packages/core` 下跑聚焦套件：
  `npx vitest run src/utils/jsonl-utils.test.ts src/utils/debugLogger.test.ts`。
- 仓库根 `npm run build`、`npm run typecheck`、`npm run bundle`。
- 变异见证，每条随后还原：移除冷却门、恢复无条件的最旧键驱逐、移除过期完成
  守卫、移除错误上下文标注、达到上限后重置尝试计数器。每条都必须让一个具名
  用例失败。
- 对改动后的源码重跑基线探针：更替场景必须在 280 次追加下报告 128 条告警，
  故障后恢复场景必须在冷却窗口后报告一条告警。
- 在最终 head 上对 writer 生命周期做 Linux 原生复核（FIFO 目标与描述符清理），
  报告实际 OS、Node 版本、appender 模式、payload 字节与原生追加结果。

## 验收标准

- 修好的 sink 在冷却窗口后，为此前已耗尽的键恰好投递一条尾部告警；未恢复的 sink
  每窗口最多放行一次尝试；尝试计数器永不重置。
- 140 个不同路径、280 次追加最多产生 128 条告警，第二轮不再新增。该上限对
  「中途没有任何投递结算」的突发同样成立，而不只对匀速追加成立。投递已失败
  槽位的驱逐仍可观察。
- 基于描述符的致命尾部错误指出其文件，保留原始 code 与身份，并继续传播而不发生
  回退追加。
- 每条新见证都检查字节、描述符生命周期或 delivery 结果，而不只是 resolve/reject；
  每个守卫都有在没有它时会失败的变异或对照。
- 日志禁用与健康 sink 的对照不新增副作用。

## 范围边界

#17852 的事项 4 **未**由 #17901 交付，仍在该跟踪 issue 中开放。Windows 原生共享
冲突行为与当前 head 的 macOS 行为需要已合入改动未曾运行其上的宿主。此前
`14893f6f10` 的 macOS 证据早于 #17771 的 writer-handle 生命周期，不被复用为验证。
跳过的 CI 任务不被当作原生平台认证：在合入 head 上，该 PR 的检查为 30 pass /
40 skipping / 0 fail，Windows 与 macOS 测试车道正在这些跳过之中。已合入改动的
Linux 原生结果都标注其实际 OS 与 Node 版本，不推广到其他平台。

同样不在范围内（与 #17852 一致）：通用跨进程追加锁、任意路径替换原子性、通用
FIFO transcript 支持、已丢失历史 JSON 字节重建、daemon 升级/重启，以及已损坏
历史的读取侧抢救（#17756）。把尾部探测与追加合并到单句柄仍是独立的性能改动。

## 待解问题

- 长驻 daemon 中，128 键的已投递抑制预算是否应当过期。本次改动保持为进程生命周期，
  因为该条件是病态的且追加路径不受影响；重新审视它需要真实工作负载触及该上限的证据。

## 参考

- 本设计的落地 PR：[#17901](https://github.com/QwenLM/qwen-code/pull/17901)，
  squash `78411506df6734efd2fcf7e627ab1b27098afd77`，PR head
  `b265c5f17ed4294594dd86374ea41ff389daceb8`。
- 验证报告：
  [#17901 评论](https://github.com/QwenLM/qwen-code/pull/17901#issuecomment-7029094987)。
  落地说明与剩余范围：
  [#17852 评论](https://github.com/QwenLM/qwen-code/issues/17852#issuecomment-7032035092)。
- 跟踪 issue：[#17852](https://github.com/QwenLM/qwen-code/issues/17852) ——
  仅就事项 4 保持开放。
- 已合入父 PR：[#17771](https://github.com/QwenLM/qwen-code/pull/17771)，squash
  `f8fa7c476f2244d5c6832fb2bb9a551882c425b3`。
- 合入后账本：[#17853](https://github.com/QwenLM/qwen-code/pull/17853)，
  [jsonl-append-verification-17771.zh-CN.md](./jsonl-append-verification-17771.zh-CN.md)。
- 独立的读取侧工作：[#17756](https://github.com/QwenLM/qwen-code/issues/17756)。
