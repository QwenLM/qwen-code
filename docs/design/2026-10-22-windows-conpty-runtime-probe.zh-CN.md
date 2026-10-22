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

下载和解压分别限 30 秒，身份查询限五秒，worker 执行限 45 秒，每个协议阶段限八秒。workflow 外层限十分钟，不自动重试。输出目录必须全新，不能覆盖已有尝试。

控制器用 PID 加 CreationDate 采样 Windows 进程身份。每次 CIM 查询仅过滤实际 worker/已捕获 PID 及 ParentProcessId 直接匹配的子进程，新观察到的子进程在同一次采样内递归查询。scratch 路径匹配仅在这些返回行内进行，不再全量扫描宿主进程。仅作为 CIM 过滤条件的 PID 不授予清理归属；种子身份必须精确匹配已捕获的 PID/start，或命令包含独占 scratch 路径。worker 启动前显式查询控制器自身 PID，预热相同 CIM 路径；worker 的初始收据仅查询自身 PID。每次查询仍限五秒，失败原样抛出。崩溃后可通过 worker-before 收据恢复 worker 身份。清理前立即重新核对 CreationDate，再停止归属明确的 PID，不按镜像名批量终止，也不终止无关 runner 进程。身份或清理无法确认时保留失败，判为不确定。进程采样不能证明原生硬崩溃后不存在未观察到且已重新托管的 helper；失败案例重试前须独立检查进程。

始终上传 `.qwen/e2e-tests/windows-pty-probe/<runtime>`，包含准备阶段失败收据、原始 worker stdout/stderr、可获得的原生身份收据、成功或普通断言失败时的终端输出及最终结果。硬崩溃可能使 worker 来不及落盘终端输出，应保留缺失事实，不能伪造记录。删除临时目录后仍保留下载可执行文件哈希。原始失败与后续尝试分别保存。

## 验证与决策

先独立静态审查，再明确授权在冻结分支执行 workflow。首次真实运行须先确认 Node 正控制，之后才能解释 Bun 结果。Node 失败时先诊断探针是否有效、是否受支持。仅 Bun 失败时结合最后记录阶段和原生崩溃/输出证据定位；基础设施、下载或证据采集失败不能当成产品回归。

候选改善需要三个案例具有相同的精确包和源码身份、完整行为收据及清洁归属关闭。若 Bun 1.4.3 通过而 Bun 1.3.14 失败，仅说明值得继续针对 Qwen Windows 测试，不等于批准生产升级或打开 Windows gate。应用级决策仍需全新整合构建与最终安装产物测试。

## 待确认问题

目前不声称 Windows 兼容性通过。Bun 1.4.3 是否实质修复所观察的原生交互、两个运行时是否暴露一致的 loaded-addon 证据，以及完整 Qwen 终端生命周期是否一致，都需要真实结果确认。任何测试工具修正必须保留原始失败和不变的行为判据。

## 首轮证据与有界观察器修正

运行 [39782916977](https://github.com/QwenLM/qwen-code/actions/runs/39782916977) 的源码为 `91edf79e1e7c8ef561e391e1368555a0cef524aa`，只选择三个显式诊断案例。三份原始 FAIL 及原始工件均保留。Node22 在五秒冷启动 PowerShell/CIM 进程观察器中超时，尚未建立原生正控制。Bun1.3.14 实际加载固定 ConPTY 模块，并返回正确 nonce/PID/三个 TTY/80x24 ready 帧，随后等待输入确认超时。Bun1.4.3 加载相同模块且完成输入确认，但 resize 后紧接着的第一份 size 帧仍为 80x24。两个 Bun 都未到达自然退出。这些混合诊断失败不能证明 Bun 独有产品缺陷，也不足以批准生产升级。独立证据审计 SHA 为 `69f1a0d1ff943899c81bac350bdd16935ad2de3ffdfd5c13b8f645d43c979c14`。

新候选按上文收窄并显式预热 CIM 采样，不增加查询、worker 或协议预算。将立即断言首份 size 帧改为原八秒 resize 阶段内的有限观察：每 100ms 最多请求一次 SIZE，直到相同 nonce/PID/三个 TTY 的元组报告精确 97x31。保留收到的全部 size 帧及第一帧，包括最初的 80x24；不能把这个原始观察重标为首帧匹配。错误 nonce/PID/TTY 仍立即失败。固定原生生产者、初始窗口、输入合同、主动退出及清理断言均不变。

递归 PID 采样只能跟踪已知祖先关系仍可见时实际观察到的进程。采样前已退出、或首次观察前已重新托管的 helper 可能不在覆盖范围内，PID 过滤查询不能证明它们不存在。因此原 Node 空 capture 列表不能证明完整归属关闭；后续运行即使通过，也保留此限制。修正后的 Node 正控制和两个 Bun 案例仍须一次新的已审 dispatch，此处不声称修正已通过。
