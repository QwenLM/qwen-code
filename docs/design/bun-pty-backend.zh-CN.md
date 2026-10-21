# Bun PTY 后端：`qwen-bun-pty`

[English](bun-pty-backend.md) | [简体中文](bun-pty-backend.zh-CN.md)

状态：已在 MYWO-8 S2 实现。建立在 S1 的运行时边界之上
（[bun-runtime-boundary.zh-CN.md](bun-runtime-boundary.zh-CN.md)）。
读者：Desktop / Web Terminal 维护者、S3（运行时兼容）、S4/S5（打包验收）。

## 问题

`getPty()` 在 Bun 运行时下禁用 PTY，原因是 `@lydell/node-pty`
"在 Desktop 的运行时下挂起"。机制现已定位：

- wrapper 通过 `tty.ReadStream` 读取 pty master fd 的输出；
- pty master fd 以**非阻塞**模式打开，无数据可读时返回 `EAGAIN`；
- Node 的 `tty.ReadStream`（libuv）把 `EAGAIN` 当作"暂无数据"，流保持
  打开；**Bun 则把它当作 `error` 事件并销毁流**；
- 销毁流会关闭 master fd。子进程继续运行，但 `onData` 永远不会触发，
  `resize` 以 `EBADF` 失败——从外部看就是挂起。

在 Bun 1.3.14 与 1.4.0 上均以 shell round-trip 复现（fd 时间线：spawn 时
`fstat` 正常 → 首次读取 `EAGAIN` → 流报错/关闭 → 后续 `fstat`/`resize`
报 `EBADF`）。两个版本行为一致，因此不能靠"等 Bun 修复"解决。

## 设计

新增后端 `packages/core/src/utils/bun-pty.ts`，仅在 Bun 下启用：

- `getPty()` 保留 `isBunRuntime()` 作为切换点。Bun 且 POSIX 时改为导入
  `bun-pty.ts`，返回 `{ name: 'qwen-bun-pty' }`。Windows 下仍保持门控
  （ConPTY 在 Bun 下未验证），并给出如实的 `loadError`。**Node 路径与
  之前逐字节一致**（`@lydell/node-pty` → `node-pty` 回退，原样保留），
  Node 行为之上没有新增代码。
- 后端复用**同一份锁定的原生产物**，但按路径加载其私有 addon。
  先用 `require.resolve('@lydell/node-pty-<platform>-<arch>')` 定位包入口，
  取 `dirname(dirname(entry))`，再加载
  `prebuilds/<platform>-<arch>/pty.node`，而不是 require 包入口。
  macOS 还会检查相邻的 `spawn-helper`，并把其路径传给 `pty.fork`。
  虽然没有 fork 原包或新增原生产物，后端直接依赖了锁定 addon 的
  私有 `fork` / `resize` / `process` API 及 prebuild 目录布局。
  包能解析并不证明预编译文件可用或 ABI 兼容；安装和暂存目录布局、
  各受支持运行时与平台仍需验证。
- 输出由**主线程异步 `fs.read` 调用**泵取 master fd。原生 fork 返回的 fd
  本就是非阻塞模式，无数据可读时返回 `EAGAIN`，由一个较短（4 ms）的定时
  器重试；一次返回了数据的读取会直接链入下一次读取。**任一时刻至多一个
  在途读取**：in-flight 守卫阻止 `resume()` 在上一次读取尚未返回时链入
  第二次读取——每次读取共用同一块 64 KiB 缓冲，交叠读取会让一个回调读到
  另一次读取的字节（输出重复/错位）。全程不构造
  `tty.ReadStream`，因此不存在被运行时误读成关闭的 `EAGAIN`。`EIO`
  （子进程退出、slave 关闭）与 `EBADF`（master 被外部关闭）都会正常结束
  泵。早期的 worker-threads/阻塞读方案已被放弃：worker 触碰 master fd
  会让 Bun 宿主在子进程退出后无法收尾（drain）。
- **退出检测依托泵。**探针证据：在 pty 上留下未排空输出的子进程，其
  原生 exit 回调只在 master fd 有读取活动时前后触发；而没有待输出内容的
  子进程即使在零读取下也会触发回调（Node 与 Bun 一致）。因此"持续读取"
  正是让"有产出的子进程"的退出可被观察到的条件——泵从构造函数起运行，
  `pause()` 后仍持续读取，直到保持区满为止（见下）。
- 写入走异步 `fs.write` 队列并带 `EAGAIN` 重试，对应 wrapper 的
  `CustomWriteStream`（字符串写入使用配置的编码）。
- 退出时序：原生 `onexit(code, signal)` 回调可能早于最后一段输出。后端
  把 exit 事件挂起，等泵结束（先冲出 `StringDecoder` 尾巴）再触发，并以
  500 ms 兜底——对应 wrapper 的 200 ms socket-destroy 兜底。每一条生命
  终点路径（泵看到 `EIO`/`EBADF`、500 ms 兜底触发、原生回调晚于泵结束）
  都执行同一套收尾：重试定时器清理、master fd 逻辑关闭、decoder 冲刷及一次
  真实 `onExit`。物理关闭等待在途 read/write 完成；`onExit` 不证明 close 系统
  调用已经完成或成功。关闭异常仍被吞掉，相关验证缺口保留。
  兜底定时器刻意不 `unref`——exit 的投递不能依赖一个
  运行时随时可以丢弃的定时器。
- POSIX `IPty` 契约逐一镜像，包括消费者依赖的细节：`pid`、`cols`/`rows`、
  `process` 标题（含 darwin 的 `kernel_task`/`spawn_helper` 回退）、
  `onData`/`onExit`（IEvent 风格的可 dispose 订阅）、`write`、`resize`
  （校验 + 像素尺寸）、`clear()` no-op、`kill(signal || 'SIGHUP')`
  （吞掉异常）、`pause`/`resume`（有界保持，见下）、`handleFlowControl`
  与 XOFF/XON 拦截（ShellExecutionService 传 `handleFlowControl: true`）、
  以及 EventEmitter 的 `error` 事件（有监听器才投递，否则记日志）。
- 与 wrapper 的 env 行为对齐：`options.env === process.env` 时套用同一份
  清理列表（`TMUX`、`TMUX_PANE`、`STY`、`WINDOW`、`WINDOWID`、`TERMCAP`、
  `COLUMNS`、`LINES`）；`PWD` 置为解析后的 cwd，`TERM` 置为
  `options.name || env.TERM || 'xterm'`。

## 暂停期间持续读取，保持区满后停读

`pause()` 不能直接让泵停下来，否则"有产出的子进程"会失去退出检测（见上文
"退出检测依托泵"一条）：探针证据——子进程退出且输出未排空后，3 秒内
master fd 零读取，原生 exit 回调从未触发（Node 与 Bun 一致）。没有该
回调，addon 也不会回收主进程（它仍响应 `kill(pid, 0)`，`ps` 中处于
exiting 状态），因此任何活性探测都无法替代读取。`onExit` 永不投递，
master fd 保持打开，宿主无法收尾——修复前已在 Bun 1.3.14 复现（pause →
子进程退出 → 无 exit 事件、fd 打开、自然收尾探针超时）；XOFF 后取消的
FD 残留报告同源于此，因为 `handleFlowControl: true` 下 XOFF 就是一次
`pause()`。

因此 `pause()` 改为继续读取并持有输出——**并置于预算之内**：

- **单 pty `pausedHoldBytes`**（默认 4 MiB）与**进程级
  `totalPausedHoldBytes`**（默认 32 MiB），按数据字节记账；
- 保持区把读取到的 chunk **拷入固定 64 KiB 块**，因此无论子进程怎么写，
  每 Buffer 的对象开销都以"一个未填满的块"为界——pty 读块大小随生产者
  剧烈变化（`awk` 洪流约 0.5 KB 一次读，`yes` 约 40 B，滴读 1 B），
  逐 chunk 保留会让微小读取把对象开销放大到字节预算之外；
- 暂停期间每次读取只申请保持区剩余的额度，因此保持区不会超出上限。唯一的
  超出来自 `pause()` 落下时已在途的那次读取，或另一个 pty 的暂停读取先占用了
  进程级总额——至多一次 64 KiB 读取。

保持的输出是逐字节精确的：由 `resume()` 按序冲出，并有字节/逐行对照的
回归钉住（2 万行洪流中 500 次无间隔 pause/resume 风暴；约 1.7 MB 洪流
全程在暂停中产生——两者都逐字节复原，且暂停中洪流后退出的子进程，其
exit 照常上报）。

**保持区满时停读，而不是失败。**任一上限没有剩余额度后，在 `resume()`
之前不再发起 master fd 读取：内核 pty 缓冲随之填满，子进程阻塞在写上——
这正是 wrapper 暂停 socket 从第一个字节起施加的背压。不丢字节、不杀进程、
不发错误，也绝不自动恢复。`resume()` 重放保持区并重新开始读取，因此超出
上限的那部分输出同样逐字节完整（`pty.stats.readParked` 暴露停读状态）。
因进程级总额而停读的 pty，同样要等到它自己的 `resume()` 才恢复读取。

这取代了早先的契约：暂停保持超过上限时以 `QWEN_PTY_OUTPUT_LIMIT` 终止
子进程树。shell 工具使用 `handleFlowControl: true`，一个 Ctrl+S（XOFF）
字节就是一次 `pause()`，旧契约会把一个可恢复的"停止滚屏"按键变成命令被
杀：洪流中单个 XOFF 后约一秒整棵进程树被杀（评审 R1-33）。

停读期间的退出检测与 wrapper 相同：带着未排空输出死亡的子进程，可能要等
读取恢复后才能完成退出（macOS 会让它停在 exiting 状态；Linux 会回收它，
挂起的 exit 经 500 ms 兜底投递）。因此 shell 工具的取消路径在向进程组发
信号之前先调用 `resume()`——未暂停时为 no-op，两种后端皆然。

自然生命终点处保持区被丢弃、暂停中的 decoder 尾巴被跳过，与 wrapper
对齐：onExit 仍恰好一次、fd 请求关闭（物理关闭等待在途操作完成），
退出后 resume 不会重放任何内容。

**写队列**仍是显式失败：排队待写的输入超过单 pty 1 MiB 或进程级 8 MiB
时，以 `QWEN_PTY_WRITE_LIMIT` 终止该 pty，而不是确认一个并不存在的背压。
终止时按真实归属杀死子进程树：主进程、其进程组、其后代，以及其会话
（Linux `sid`）或控制终端（macOS `tdev`）上的所有进程——在主进程尚未被回收
时由 `ps` 列出。这份列表包括交互式 shell 放在独立进程组里的前台作业。先发
SIGTERM；500 ms 宽限后对重新列出的进程发 SIGKILL，早先的成员只有在仍是同一
进程（启动时间相同）时才保留，因此不会向被复用的 pid 发信号。随后关闭
master fd，终结所有排空路径（重试定时器、挂起的 exit、保持区、写队列）。失败之后 `write` 与 `resize` 均为 no-op（与其上层的
registry 守卫一致），在途读取迟到的字节既不投递也不重新计入（已释放
的）保持预算，`resume()` 重放会在第一个终止本 pty 的数据监听器处停止。
随后在 `error` 事件上恰好投递一次结构化 `PtyLimitError`，带稳定 `code`
（`QWEN_PTY_WRITE_LIMIT`；准入为 `QWEN_PTY_ACTIVE_LIMIT`）、`limitKind`、
`limit`、已接收字节数，以及是否丢弃了未投递的输入。`onExit` 仍只为真实
原生退出保留：超限终止之后才到达的原生回调只会被记录
（`pty.stats.nativeExitRecord`）——绝不作为第二个终态事件投递，也绝不
被伪造成交互退出码。

**活跃 pty 数量**同样有上限（默认 64，为 Web Terminal 的 8 个会话准入
上限留出余量）：超限的 `spawn` 同步抛出 `QWEN_PTY_ACTIVE_LIMIT`。
`getPtyBudgetStats()` 与 `pty.stats` 暴露保持/排队/准入计数，供探针与
测试使用；生产代码不修改 `processPtyBudget`，测试调整后会恢复。

"放慢读取"（超过高水位后每个定时周期只读一次）作为背压机制已被探针
否决：每个周期只能推进约 1 KiB（部分读取时 pty 每次至多给出一个小块），
洪流要暂停数分钟，而且它最终仍无法在"不丢字节"的前提下给内存设界。早先
草稿曾把该探针解读为"内核层面的字节流破坏"，该说法已**撤回**——把
termios 输出处理（ONLCR）计入后，连续排空与滴读两条臂在 Node 和 Bun 上
产出逐字节一致，并未定位到任何破坏机制。有界保持在上限之内全速读取且
逐字节精确，到达上限后停读，在不丢任何字节的前提下给内存设界。

### 失败在消费者侧的接线

- **ShellExecutionService（前台 PTY 路径）**：`QWEN_PTY_WRITE_LIMIT`
  的 error 事件会把执行收敛为 `error` 有值、
  `exitCode`/`signal` 为 `null` 的结果——一次可见的失败，不伪造原生
  退出码，工具结果绝不会是 `success`。Node 后端从不产生这些 code，
  Node 行为不变；自然退出路径仍只由 `onExit` 收敛。被活跃 pty 上限
  拒绝的 spawn 返回显式错误，原生 exit/signal 为 null、执行方式为 `none`；
  不通过 child_process fallback 绕过上限。取消时先 `resume()` 再向进程组
  发信号，因此 XOFF 之后的取消仍能观察到退出。
- **Web Terminal（`web-terminal-registry` + `serve` 路由）**：registry
  订阅后端 `error` 事件，把会话标记为 failed，并释放 PTY（不再向已被
  杀死的进程树重复发信号）。路由转发显式 `{type: 'error'}` 控制帧
  （客户端以红色渲染），以 4001 关闭 socket（客户端视为不可重试），
  `readSnapshot` 携带 `failed`/`failureMessage`；failed 会话上的
  write/resize 会被拒绝。
- **意外 PTY 错误**按消费者区分：前台监听器 throw；registry 忽略 EIO/EAGAIN，
  其他非限额错误交给 `debugLogger.warn`。warn 不代表会话 failed 或收尾已完成，
  没有活动 debug 会话时也可能不留盘。

每一条输入帧都受 registry 累计输入门禁限制，包括空闲终端的首帧：若加入后
未确认输入超过 256 KiB，该帧会在到达后端之前以 `backpressure` 拒绝，因此单次
超大粘贴不会触发后端未变的 1 MiB 写队列上限而使会话失败。后端上限仍约束累计
排队写入：超过时显式使会话失败；输入不会拆分、重放或被静默接受。后续若要
增加输入预准入政策，须另行决策。

探针钉住的参考行为（Node wrapper，pause → 子进程以 code 7 退出）：经
socket-destroy 兜底在子进程死后约 200 ms 恰好触发一次 `onExit`，此后
fd 报 `EBADF`，尾部输出不投递。对"暂停中仍在读取（保持区未满）时死亡"
的子进程，后端现仍在两个运行时上对齐该契约，只是没有那 200 ms 延迟
（泵能直接看到 `EIO`）。

## 明确不在本次范围

- **Windows 下的 Bun** — 门控保留并给出如实原因；需先在 Bun 下验证
  ConPTY（`useConptyDll`）。
- **`packages/cli/src/agent-view/pty-host.ts`** — agent view 本次仍保留
  自身 Bun 门控；接入 `qwen-bun-pty` 是一个小型后续项，不属于 S2 交付物。
- **发布冒烟** — `packages/desktop/scripts/smoke-runtime.js` 通过打包的 Node 验证
  PTY round-trip；Bun 一侧的 PTY 冒烟属于 S5 在真实产物上的验收工作。

## 打包

`scripts/create-standalone-package.js` 之前只为 `node` flavor 暂存
node-pty 包（"getPty() 在 Bun 下返回 null"）。现在 `bun` flavor 也一并
暂存——`lib/node_modules/@lydell/node-pty(-<platform>-<arch>)`——因为
`bun-pty.ts` 在运行时通过 `createRequire(import.meta.url)` 解析同一个
平台包；`esbuild.config.js` 的 externals 已把所有 node-pty specifier
留在 bundle 外，且由于同一步骤现在对两种 flavor 都执行，
`QWEN_STANDALONE_REQUIRE_NODE_PTY_PREBUILD=1` 的发布硬失败自动继承。

## 验证

### R2-8 待执行验证清单

仅为计划，NOT_RUN，不代表已通过：

- [ ] 逻辑关闭时分别保持真实异步 read 回调、write 回调在途，观察
      `closeSync(fd)` 延迟、新 I/O 被拒绝，以及最后持有回调收敛之前数字 fd
      仍打开；覆盖两者同时在途及两种完成顺序，第一个回调完成不得关闭 fd。
- [ ] 成功路径记录最后回调完成后的恰好一次 close 尝试及独立的描述符
      关闭见证。`onExit`、`fdClosed` 或预算释放均不能单独证明物理关闭。
- [ ] 注入非 EBADF 的 close 失败，记录尝试、errno 与描述符状态；当前
      catch 吞掉错误，没有独立见证不得称已释放，无法证明物理关闭则保留
      UNKNOWN。解释 EBADF 时须控制描述符复用，不外推树/FD 整体收敛。

### 既有验证清单（本轮未复验）

- `packages/core/src/utils/bun-pty.test.ts` — vitest/Node 下的行为套件
  （后端是主线程异步代码，与运行时无关）：输出流、写入、`resize` 后
  子进程的 `stty size`、kill→`onExit` 带 signal、进程回收、pause/resume、
  流控拦截、`encoding: null`、进程标题、`clear()`，以及暂停生命周期
  回归：子进程在暂停中退出时 exit 恰好一次且 fd 被释放、暂停中 3 MB
  洪流下退出检测仍存活（为其显式调大保持上限）、2 万行洪流中 500 次
  无间隔 pause/resume 风暴后字节/逐行对照完全一致、约 1.7 MB 洪流全程
  暂停保持后 resume 逐字节复原、XOFF 流控暂停后 `kill()` 释放 fd。
  资源上限套件钉住停读契约：暂停洪流超过单 pty 上限时停读、无错误、
  子进程存活、保持区不超上限且不再增长，随后 `resume()` 逐字节交付全部
  输出且子进程仍可交互；停读中被杀的子进程仍恰好上报一次退出、全部预算
  释放；预算内洪流经 pause/resume 后逐字节一致；进程级上限让触及它的
  pty 恰好在总额处停读，两个 pty 均不失败且都无损重放；写队列上限以
  `QWEN_PTY_WRITE_LIMIT` 终止（不伪造背压确认），并回收交互式 shell 在独立
  进程组中运行、忽略 TERM/HUP 的前台作业；活跃 pty 上限以 `QWEN_PTY_ACTIVE_LIMIT` 拒绝下一次
  `spawn`，关闭后槽位释放；预算计数可经 `getPtyBudgetStats()` 观察。
  fd 生命周期套件（`defers the fd close while a read is still owned by the
threadpool` 与 `defers the fd close while a write is still owned by the
threadpool`）分别在逻辑关闭时保持一个在途 read 和一个在途 write，
  覆盖两种完成顺序（第一个完成不得关闭 fd），并断言最后一次持有者
  收敛前仅有一次 close 尝试且 fd 仍打开。这些测试区分逻辑终止与最终
  物理关闭，不声称 close 系统调用成功。
- `packages/core/src/utils/bun-pty.node-bun.test.ts` — 跨运行时一侧
  （S1 harness 模式）：fixture 导入真实的 `getPty.ts`，在真实 `bun`
  二进制（BUN_TEST_BIN）下断言 `qwen-bun-pty` 后端可加载并完成
  spawn/输出/resize/kill round-trip；第二个 fixture 驱动暂停退出
  生命周期（pause → 子进程退出 → `onExit` 恰好一次、fd 释放、宿主自然
  退出），并在 **Node 与 Bun 两个运行时**下运行；第三个 fixture 在
  5000 行洪流中做 300 次无间隔 pause/resume，断言两个运行时下字节流
  均逐字节且逐行完整；第四个 fixture 在真实 Bun 运行时下驱动超过保持
  上限的暂停洪流（停读、无错误、子进程存活，随后 `resume()` 逐字节交付、
  子进程自然退出、fd 释放、宿主自然收尾）；第五个 fixture 在真实 Bun
  运行时下驱动写队列上限（恰好一次 `QWEN_PTY_WRITE_LIMIT`、队列清空、
  无 `onExit`、fd 释放、子进程树消失、宿主自然收尾）。无 `bun` 时与
  S1 套件一样跳过。
- `packages/core/src/utils/getPty.test.ts` — Bun 分支从"返回 null 并报
  disabled 原因"翻转为"加载 `qwen-bun-pty` 且不 spawn"；Bun 下的
  Windows 保持如实门控；可失败分支的按调用 `loadError` 契约（#11881）
  继续被钉住。
- Bun 1.3.14 证据运行：后端探针（原生 addon 加载、fd 保持健康、resize
  正常）与真实产品路径（Bun 下运行 CLI `serve`、创建 Web Terminal、
  shell 工具 PTY round-trip）——记录在 MYWO-8 S2 交付评论中。
