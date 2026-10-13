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
- 输出由 `node:worker_threads` Worker 以阻塞 `fs.readSync` 泵取 master
  fd。未在上面构造 `ReadStream` 的 fd 默认保持阻塞模式，读取会停在内核
  直到有数据或终局——无需轮询，也不存在被运行时误读成关闭的 `EAGAIN`。
  `EIO`（子进程退出、slave 关闭）与 `EBADF`（master 被外部关闭）都会
  正常结束泵。
- 写入走异步 `fs.write` 队列并带 `EAGAIN` 重试，对应 wrapper 的
  `CustomWriteStream`（字符串写入使用配置的编码）。
- 退出时序：原生 `onexit(code, signal)` 回调可能早于最后一段输出。后端
  把 exit 事件挂起，等泵结束（先冲出 `StringDecoder` 尾巴）再触发，并以
  500 ms 销毁超时兜底——对应 wrapper 的 200 ms socket-destroy 兜底。
- POSIX `IPty` 契约逐一镜像，包括消费者依赖的细节：`pid`、`cols`/`rows`、
  `process` 标题（含 darwin 的 `kernel_task`/`spawn_helper` 回退）、
  `onData`/`onExit`（IEvent 风格的可 dispose 订阅）、`write`、`resize`
  （校验 + 像素尺寸）、`clear()` no-op、`kill(signal || 'SIGHUP')`
  （吞掉异常）、`pause`/`resume`（worker 级读控）、`handleFlowControl`
  与 XOFF/XON 拦截（ShellExecutionService 传 `handleFlowControl: true`）、
  以及 EventEmitter 的 `error` 事件（有监听器才投递，否则记日志）。
- 与 wrapper 的 env 行为对齐：`options.env === process.env` 时套用同一份
  清理列表（`TMUX`、`TMUX_PANE`、`STY`、`WINDOW`、`WINDOWID`、`TERMCAP`、
  `COLUMNS`、`LINES`）；`PWD` 置为解析后的 cwd，`TERM` 置为
  `options.name || env.TERM || 'xterm'`。

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
  （后端是与运行时无关的 worker 代码）：输出流、写入、`resize` 后子进程
  的 `stty size`、kill→`onExit` 带 signal、进程回收、pause/resume、
  流控拦截、`encoding: null`、进程标题、`clear()`。
- `packages/core/src/utils/bun-pty.node-bun.test.ts` — 跨运行时一侧
  （S1 harness 模式）：fixture 导入真实的 `getPty.ts`，在真实 `bun`
  二进制（BUN_TEST_BIN）下断言 `qwen-bun-pty` 后端可加载并完成
  spawn/输出/resize/kill round-trip。无 `bun` 时与 S1 套件一样跳过。
- `packages/core/src/utils/getPty.test.ts` — Bun 分支从"返回 null 并报
  disabled 原因"翻转为"加载 `qwen-bun-pty` 且不 spawn"；Bun 下的
  Windows 保持如实门控；可失败分支的按调用 `loadError` 契约（#11881）
  继续被钉住。
- Bun 1.3.14 证据运行：后端探针（原生 addon 加载、fd 保持健康、resize
  正常）与真实产品路径（Bun 下运行 CLI `serve`、创建 Web Terminal、
  shell 工具 PTY round-trip）——记录在 MYWO-8 S2 交付评论中。
