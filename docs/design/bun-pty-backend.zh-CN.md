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
- 后端**直接驱动同一份锁定的原生 addon**：
  `require('@lydell/node-pty-<platform>-<arch>')` → `pty.fork` /
  `pty.resize` / `pty.process`。不 fork `@lydell/node-pty`、不新增原生
  产物、不扩大 ABI 面。
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
- **退出检测依托泵。**隔离探针证据：该 addon 的原生 `onexit` 回调在
  master fd 完全没有读取活动时不会触发（Node 与 Bun 一致）——它围绕
  到达生命终点的读取触发。因此泵从构造函数起运行，且不会因 `pause()`
  而停止（见下）。
- 写入走异步 `fs.write` 队列并带 `EAGAIN` 重试，对应 wrapper 的
  `CustomWriteStream`（字符串写入使用配置的编码）。
- 退出时序：原生 `onexit(code, signal)` 回调可能早于最后一段输出。后端
  把 exit 事件挂起，等泵结束（先冲出 `StringDecoder` 尾巴）再触发，并以
  500 ms 兜底——对应 wrapper 的 200 ms socket-destroy 兜底。每一条生命
  终点路径（泵看到 `EIO`/`EBADF`、500 ms 兜底触发、原生回调晚于泵结束）
  都执行同一套收尾：decoder 冲刷、重试定时器清理、master fd 关闭，然后
  恰好一次 `onExit`。兜底定时器刻意不 `unref`——exit 的投递不能依赖一个
  运行时随时可以丢弃的定时器。
- POSIX `IPty` 契约逐一镜像，包括消费者依赖的细节：`pid`、`cols`/`rows`、
  `process` 标题（含 darwin 的 `kernel_task`/`spawn_helper` 回退）、
  `onData`/`onExit`（IEvent 风格的可 dispose 订阅）、`write`、`resize`
  （校验 + 像素尺寸）、`clear()` no-op、`kill(signal || 'SIGHUP')`
  （吞掉异常）、`pause`/`resume`（缓冲保持，见下）、`handleFlowControl`
  与 XOFF/XON 拦截（ShellExecutionService 传 `handleFlowControl: true`）、
  以及 EventEmitter 的 `error` 事件（有监听器才投递，否则记日志）。
- 与 wrapper 的 env 行为对齐：`options.env === process.env` 时套用同一份
  清理列表（`TMUX`、`TMUX_PANE`、`STY`、`WINDOW`、`WINDOWID`、`TERMCAP`、
  `COLUMNS`、`LINES`）；`PWD` 置为解析后的 cwd，`TERM` 置为
  `options.name || env.TERM || 'xterm'`。

## 暂停期间仍持续读取，且无损

`pause()` 不能让泵停下来，否则会失去退出检测（见上文"退出检测依托泵"
一条）：读取一停，原生 exit 回调永不触发，**且 addon 永不回收子进程**——
探针证据：子进程退出后 3 秒内 master fd 零读取，exit 回调从未触发，
子进程一直是未被回收的僵尸（Node 与 Bun 一致），因此任何活性探测
（`kill(pid, 0)` 看不见僵尸）都无法替代读取。`onExit` 永不投递，master fd
保持打开，宿主无法收尾——修复前已在 Bun 1.3.14 复现（pause → 子进程
退出 → 无 exit 事件、fd 打开、自然收尾探针超时）；XOFF 后取消的 FD
残留报告同源于此，因为 `handleFlowControl: true` 下 XOFF 就是一次
`pause()`。

因此 `pause()` 改为持有输出而不是停止读取，**且无损**：暂停期间到达的
chunk 全部进入进程内保持区，`resume()` 按序冲出；任何内容都不会被
丢弃，也没有上限。有字节/逐行对照的回归钉住这一点：2 万行洪流中 500 次
无间隔 pause/resume 风暴后字节流逐字节复现；约 1.9 MB 洪流全程在暂停中
产生，resume 后逐字节复原（暂停中洪流 3 MB 后退出的子进程，其 exit 照常
上报）。生命终点处保持区被丢弃、暂停中的 decoder 尾巴被跳过，与 wrapper
对齐——wrapper 的 exit 兜底销毁 socket 时，暂停中的 ReadStream 同样丢失
已缓冲数据：onExit 仍恰好一次、fd 被释放，但退出后 resume 不会重放任何
内容。

代价是公开的：暂停期间洪流会让保持区无界增长，因为唯一的真背压——停止
读取——正是本后端做不到的那件事（见上）。退而求其次的"放慢读取"（超过
高水位后每个定时周期只读一次）已被探针**否决**：对已满的 pty 输出队列
做部分排空会在内核层面破坏字节流（读边界处多出 `\r`、尾部片段重复，所有
探测的放慢频率均复现），且每个周期只能推进约 1 KiB（部分读取时 pty 每次
至多给出一个行级小块）。供决策的选项：

1. **无损保持（已实现）** — 字节精确、退出检测存活；代价是暂停洪流下
   内存无界。当暂停短暂、由 UI 驱动时可接受（当前消费者只在 XOFF 流控
   时暂停）。
2. **真内核背压 + 带外退出检测** — 超过高水位后停止读取，改由外部机制
   感知子进程死亡（如经 `ps` 轮询僵尸态，或回收看门狗）。内存有界，但
   需要新增一个 addon 并不提供的平台相关机制，且关闭前仍需最后一次
   排空。
3. **有界保持 + 显式溢出策略** — 保留上限，但把溢出以 `error` 事件或
   自动 resume 的方式显式暴露而不是静默丢弃；数据仍会丢，但是"大声地"
   丢，且调用方掌握控制权。

探针钉住的参考行为（Node wrapper，pause → 子进程以 code 7 退出）：经
socket-destroy 兜底在子进程死后约 200 ms 恰好触发一次 `onExit`，此后
fd 报 `EBADF`，尾部输出不投递。后端现已在两个运行时上对齐该契约，
只是没有那 200 ms 延迟（泵能直接看到 `EIO`）。

## 明确不在本次范围

- **Windows 下的 Bun** — 门控保留并给出如实原因；需先在 Bun 下验证
  ConPTY（`useConptyDll`）。
- **`packages/cli/src/agent-view/pty-host.ts`** — agent view 本次仍保留
  自身 Bun 门控；接入 `qwen-bun-pty` 是一个小型后续项，不属于 S2 交付物。
- **发布冒烟** — `desktop/scripts/smoke-runtime.js` 通过打包的 Node 验证
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

- `packages/core/src/utils/bun-pty.test.ts` — vitest/Node 下的行为套件
  （后端是主线程异步代码，与运行时无关）：输出流、写入、`resize` 后
  子进程的 `stty size`、kill→`onExit` 带 signal、进程回收、pause/resume、
  流控拦截、`encoding: null`、进程标题、`clear()`，以及暂停生命周期
  回归：子进程在暂停中退出时 exit 恰好一次且 fd 被释放、暂停中 3 MB
  洪流下退出检测仍存活、2 万行洪流中 500 次无间隔 pause/resume 风暴后
  字节/逐行对照完全一致、约 1.9 MB 洪流全程暂停保持后 resume 逐字节
  复原、XOFF 流控暂停后 `kill()` 释放 fd。
- `packages/core/src/utils/bun-pty.node-bun.test.ts` — 跨运行时一侧
  （S1 harness 模式）：fixture 导入真实的 `getPty.ts`，在真实 `bun`
  二进制（BUN_TEST_BIN）下断言 `qwen-bun-pty` 后端可加载并完成
  spawn/输出/resize/kill round-trip；第二个 fixture 驱动暂停退出
  生命周期（pause → 子进程退出 → `onExit` 恰好一次、fd 释放、宿主自然
  退出），并在 **Node 与 Bun 两个运行时**下运行；第三个 fixture 在
  5000 行洪流中做 300 次无间隔 pause/resume，断言两个运行时下字节流
  均逐字节且逐行完整。无 `bun` 时与 S1 套件一样跳过。
- `packages/core/src/utils/getPty.test.ts` — Bun 分支从"返回 null 并报
  disabled 原因"翻转为"加载 `qwen-bun-pty` 且不 spawn"；Bun 下的
  Windows 保持如实门控；可失败分支的按调用 `loadError` 契约（#11881）
  继续被钉住。
- Bun 1.3.14 证据运行：后端探针（原生 addon 加载、fd 保持健康、resize
  正常）与真实产品路径（Bun 下运行 CLI `serve`、创建 Web Terminal、
  shell 工具 PTY round-trip）——记录在 MYWO-8 S2 交付评论中。
