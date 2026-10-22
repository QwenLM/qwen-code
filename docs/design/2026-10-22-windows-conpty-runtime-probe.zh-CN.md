# Windows ConPTY 运行时诊断

[English](2026-10-22-windows-conpty-runtime-probe.md) | [简体中文](2026-10-22-windows-conpty-runtime-probe.zh-CN.md)

## 状态与问题

2026-10-22：首轮 Windows 诊断已有三份原始失败；下述有界观察器修正为新的作者候选，NOT_RUN。现有迁移证据不能证明固定版本的 Windows PTY 原生模块能在 Bun 下工作。本诊断比较 Node 22.23.2 正控制、Bun 1.3.14 基线和 Bun 1.4.3 候选，再决定运行时变化是否值得继续调查。macOS 结果不能证明 Windows 兼容性。

## 范围与既有行为

复用已注册的 `verify-landlock-helper.yml`，增加默认 false 的布尔输入 `windows_pty_probe`。仅显式手工传 true 时选择新增 Windows x64 矩阵，并跳过原来的三个 job。PR、main push 和默认手工触发仍执行原 job。诊断不修改生产 Bun/OpenTUI 版本、依赖清单、Windows gate、默认 renderer 或 Qwen 启动链路，不新增迁移碎片 PR。

该探针测试隔离的已发布包，不属于工作区安装验收。它不覆盖 Windows ARM64、完整 Qwen 渲染、认证、npm/standalone 分发或人类操作的终端宿主。即使三个案例全通过，这些仍需单独验收。

## 运行时与包身份

控制器使用既有固定 setup-node action 配置 Node 22.23.2。矩阵每格只下载 `@lydell/node-pty` 和 `@lydell/node-pty-win32-x64` 的 `1.2.0-beta.10`。两个压缩包必须匹配已提交 lockfile 的精确 SHA512，在独占临时目录中解压，不调用包管理器或生命周期脚本。

Bun 压缩包为官方 release 资产 `bun-windows-x64.zip`，通过 `gh release download` 和 workflow 只读 token 下载。2026-10-22 已通过 `gh api` 读取 GitHub release 元数据：

| 运行时     | Release                                                                | 压缩包 SHA256                                                      |
| ---------- | ---------------------------------------------------------------------- | ------------------------------------------------------------------ |
| Bun 1.3.14 | [bun-v1.3.14](https://github.com/oven-sh/bun/releases/tag/bun-v1.3.14) | `0a0620930b6675d7ba440e81f4e0e00d3cfbe096c4b140d3fff02205e9e18922` |
| Bun 1.4.3  | [bun-v1.4.3](https://github.com/oven-sh/bun/releases/tag/bun-v1.4.3)   | `0bf84e808552beea67bf1202a287a35c6c825d837b287b3f8e9dd513dba35d3d` |

记录源码 HEAD/tree、驱动和 lock 哈希、下载 URL/摘要/大小、实际可执行文件路径/哈希/版本、包装入口哈希、原生二进制清单，以及实际加载的 `conpty.node` 路径/哈希。仅列出文件不能证明已加载。若运行时缺少 require-cache 证据，应判为证据不完整，不能据此证明原生模块缺陷。

## 驱动与行为判据

`scripts/diagnostics/windows-pty-probe.mjs` 包含 Node 控制器和由目标运行时执行的 worker。worker 加载真实包，通过 `useConptyDll: true` 的 bundled ConPTY 启动 Node 22 载荷，与 base 7368 的实际 `ShellExecutionService` 在 Windows 上选择的后端一致。inbox 后端不在本探针范围内；生产使用 bundled 后端避免自然退出后留下孤立 console host。固定载荷有助于隔离 PTY 宿主运行时，不代表 Bun 子进程也已通过。载荷使用带 nonce 的短数组帧，避免在 80 列处折行。

每案必须同时观察到：

1. 真实 PTY 子进程的 stdin、stdout、stderr 均为 TTY，PID 正确，初始窗口为 80 列、24 行。
2. `terminal.write` 写入的 nonce 被子进程实际消费并确认。
3. `terminal.resize(97, 31)` 反映在子进程实际窗口尺寸查询中。
4. 退出输入产生最终 nonce 标记，子进程主动以 0 退出。强制终止不能算成功。
5. worker 以 0 退出，所有已观察的独占 PID/start 身份均已消失。原生身份缺失、超时、清理介入、崩溃、协议失败或原始证据缺失均不能通过。

`scripts/tests/verify-landlock-helper-workflow.test.js` 针对原 workflow 条件和矩阵约束提供静态用例。候选准备时该测试同样 NOT_RUN。

## 预算、归属与证据

下载和解压分别限 30 秒。worker 启动前唯一一次控制器自身初始化查询显式限 15 秒，其余身份查询仍限五秒，worker 执行限 45 秒，每个协议阶段限八秒。workflow 外层限十分钟，不自动重试。输出目录必须全新，不能覆盖已有尝试。

控制器用 PID 加 CreationDate 采样 Windows 进程身份。每次 CIM 查询仅过滤实际 worker/已捕获 PID 及 ParentProcessId 直接匹配的子进程，新观察到的子进程在同一次采样内递归查询。scratch 路径匹配仅在这些返回行内进行，不再全量扫描宿主进程。仅作为 CIM 过滤条件的 PID 不授予清理归属；种子身份必须精确匹配已捕获的 PID/start，或命令包含独占 scratch 路径。worker 启动前显式查询控制器自身 PID，预热相同 CIM 路径；worker 的初始收据仅查询自身 PID。只有这一次初始化查询限 15 秒，并记录预算和实际耗时（包括失败），不吞异常、不重试。worker 身份查询及所有后续采样仍限五秒，失败原样抛出。崩溃后可通过 worker-before 收据恢复 worker 身份。清理前立即重新核对 CreationDate，再停止归属明确的 PID，不按镜像名批量终止，也不终止无关 runner 进程。身份或清理无法确认时保留失败，判为不确定。进程采样不能证明原生硬崩溃后不存在未观察到且已重新托管的 helper；失败案例重试前须独立检查进程。

始终上传 `.qwen/e2e-tests/windows-pty-probe/<runtime>`，包含准备阶段失败收据、原始 worker stdout/stderr、可获得的原生身份收据、成功或普通断言失败时的终端输出及最终结果。硬崩溃可能使 worker 来不及落盘终端输出，应保留缺失事实，不能伪造记录。删除临时目录后仍保留下载可执行文件哈希。原始失败与后续尝试分别保存。

## 验证与决策

先独立静态审查，再明确授权在冻结分支执行 workflow。首次真实运行须先确认 Node 正控制，之后才能解释 Bun 结果。Node 失败时先诊断探针是否有效、是否受支持。仅 Bun 失败时结合最后记录阶段和原生崩溃/输出证据定位；基础设施、下载或证据采集失败不能当成产品回归。

候选改善需要三个案例具有相同的精确包和源码身份、完整行为收据及清洁归属关闭。若 Bun 1.4.3 通过而 Bun 1.3.14 失败，仅说明值得继续针对 Qwen Windows 测试，不等于批准生产升级或打开 Windows gate。应用级决策仍需全新整合构建与最终安装产物测试。

## 待确认问题

目前不声称 Windows 兼容性通过。Bun 1.4.3 是否实质修复所观察的原生交互、两个运行时是否暴露一致的 loaded-addon 证据，以及完整 Qwen 终端生命周期是否一致，都需要真实结果确认。任何测试工具修正必须保留原始失败和不变的行为判据。

## 首轮证据与有界观察器修正

运行 [39782916977](https://github.com/QwenLM/qwen-code/actions/runs/39782916977) 的源码为 `91edf79e1e7c8ef561e391e1368555a0cef524aa`，只选择三个显式诊断案例。三份原始 FAIL 及原始工件均保留。Node22 在五秒冷启动 PowerShell/CIM 进程观察器中超时，尚未建立原生正控制。Bun1.3.14 实际加载固定 ConPTY 模块，并返回正确 nonce/PID/三个 TTY/80x24 ready 帧，随后等待输入确认超时。Bun1.4.3 加载相同模块且完成输入确认，但 resize 后紧接着的第一份 size 帧仍为 80x24。两个 Bun 都未到达自然退出。这些混合诊断失败不能证明 Bun 独有产品缺陷，也不足以批准生产升级。独立证据审计 SHA 为 `69f1a0d1ff943899c81bac350bdd16935ad2de3ffdfd5c13b8f645d43c979c14`。

首个观察器修正按上文收窄并显式预热 CIM 采样，当时不增加查询、worker 或协议预算。将立即断言首份 size 帧改为原八秒 resize 阶段内的有限观察：每 100ms 最多请求一次 SIZE，直到相同 nonce/PID/三个 TTY 的元组报告精确 97x31。保留收到的全部 size 帧及第一帧，包括最初的 80x24；不能把这个原始观察重标为首帧匹配。错误 nonce/PID/TTY 仍立即失败。固定原生生产者、初始窗口、输入合同、主动退出及清理断言均不变。

递归 PID 采样只能跟踪已知祖先关系仍可见时实际观察到的进程。采样前已退出、或首次观察前已重新托管的 helper 可能不在覆盖范围内，PID 过滤查询不能证明它们不存在。因此原 Node 空 capture 列表不能证明完整归属关闭；后续运行即使通过，也保留此限制。修正后的 Node 正控制和两个 Bun 案例仍须一次新的已审 dispatch，此处不声称修正已通过。

## 第二轮后的仅初始化预算修正

运行 [39787064396](https://github.com/QwenLM/qwen-code/actions/runs/39787064396) 的源码为 `35300c37fe00adfe22c7236013b515ce14da28b8`，另三份原始 FAIL 完整保留。Node22 的控制器自身过滤 CIM 预热仍超出五秒，尚未启动 worker。Bun1.3.14 到达 ready，但没有输入确认。Bun1.4.3 确认输入后，在未变的八秒阶段内产生 79 份 nonce/PID/三个 TTY 正确的 size 帧，全部仍为 80x24，原首帧继续记录。两个 Bun 都未到达主动退出。独立审计 SHA 为 `6ea713e9a73cacfa544385b9b50c3b5f65d327d58290bf97454f0dd4fdf4d071`。这些观察不足以延长产品时限或升级 Bun。

新的作者候选仅将 worker 前控制器自身 CIM 初始化改为独立有界 15 秒，并记录配置预算与成功或失败时的实际耗时。默认及其他查询仍五秒，worker 仍 45 秒，input/resize 仍八秒，SIZE 间隔仍 100ms，重试仍为零。失败继续抛出。前两份五秒失败保持原始证据；修正候选仍为 NOT_RUN，等待审查和一次新的 dispatch。

## 第三轮后的实时原生尺寸判据

运行 [39790195471](https://github.com/QwenLM/qwen-code/actions/runs/39790195471) 的源码为 `27efffaba0cf071a40f1bf1dcf1a15f73ec25410`，另三份原始 FAIL 保留。Node22 初始化耗时 5008.423ms，位于显式 15000ms 预算内，随后确认真实 ConPTY 加载、ready 与输入往返，但仍返回 64 份缓存 80x24 size 帧；Bun1.4.3 确认输入后返回 78 份同样的帧，Bun1.3.14 再次输入超时。没有案例到达主动退出。独立审计 SHA 为 `5ae3e4fe639208e3d9e2bd749725d4c5e3cb88c0ace37ac9df0222f8d21d23fd`。此前九份失败均保持不变。

精确官方 Node `v22.23.2` 源码说明这些尺寸帧不足以证明原生 resize 缺陷：[`lib/tty.js:164`](https://github.com/nodejs/node/blob/v22.23.2/lib/tty.js#L164) 只返回缓存 columns/rows；[`src/tty_wrap.cc:90–110`](https://github.com/nodejs/node/blob/v22.23.2/src/tty_wrap.cc#L90) 要求数组参数，调用原生窗口查询，仅在返回码为零时填写 width/height，并返回数值状态码。Windows 的 [`deps/uv/src/win/tty.c:440–455`](https://github.com/nodejs/node/blob/v22.23.2/deps/uv/src/win/tty.c#L440) 对实际 TTY handle 调用 `GetConsoleScreenBufferInfo`，更新 virtual window 并返回尺寸；失败返回转换后的 Windows 错误码。这个内部 API 仅用于固定 Node22 诊断载荷，不新增生产接口。

新的 NOT_RUN 候选保留所有原缓存帧及 nonce/PID/三个 TTY 断言。同一固定载荷另发短 `native-<kind>` 帧，包含 nonce、PID、原生返回码和实时尺寸，避免将两种观察塞进单行而超过原 80 列终端。初始 native ready 和 input 必须返回精确 80x24、状态码零。resize 必须由状态码零的原生查询返回实际 97x31，不能用缓存值或硬编码目标。并列保留 `firstResizeFrame`/全部缓存 `resizeFrames`，以及 `firstNativeResizeFrame`/全部 `nativeFrames`，失败也保留。缓存可能仍为 80x24、原生已是 97x31，两者按各自含义同时记录。

不修改 runtime、原生包/后端、生产代码或预算。初始化 CIM15秒、后续查询5秒、worker45秒、协议8秒、SIZE100ms 和零重试不变。仍须独立审查和新的 Node 正控制，之后才能解释运行时差异。此候选不代表完整 Qwen Windows 验收通过，也不批准升级。
