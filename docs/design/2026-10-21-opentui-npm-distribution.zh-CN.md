# POSIX npm OpenTUI 分发

[English](2026-10-21-opentui-npm-distribution.md) | [简体中文](2026-10-21-opentui-npm-distribution.zh-CN.md)

**已合并 [#14959](https://github.com/QwenLM/qwen-code/pull/14959) 的运行时后续批次。** 本批将 OpenTUI 统一为 Bun-only，并把 npm 私有运行时和 standalone preview 的 Bun pin 更新为 **1.4.4**，OpenTUI 保持 **0.5.10**。该更新包含上游 Brotli decoder 错误传播修复，不改变直接运行时兼容下限或默认 renderer。当前提案从原 `249ab50d` 基线整合 main `949a71e2`，本次整合产物的安装与平台验收尚未执行。

历史证据保持其原始产物归属：main `32b4234b` 加早期运行时改动通过正常 build/typecheck/bundle、87 项 CLI 和 46 项打包/工作流测试。真实 Node 26.4.0/npm 11.17.0 pack 与自有目录 `--ignore-scripts` 安装验证了 1,355 个发布文件及执行权限，解包大小为 152,316,775 字节，低于 160 MiB。一项 macOS arm64 strict 安装版 smoke 观察到 Node launcher、同安装私有 Bun 1.4.4、原生库、一次模型 HTTP、语法分色及 `/quit` 自然退出 0。随后禁用 relaunch、缺失私有 Bun、继承 FFI flag 的 fallback/strict 六项拒绝负控通过。这些不是本次新整合产物、其他安装布局、npm 子进程身份或其他平台的验收。

早期正常 standalone updater 矩阵在真实 Node 24.19 与 Bun 1.4.4 宿主通过 152 个合成场景（各 76），使用验证证书的 loopback HTTPS 与无签名 CLI/版本归档。Node registry 调度注入了 npm executor；Bun probe 不可观察。后续本地 `a28ba265` 整合通过 fresh build/typecheck/bundle 和 133 项受影响单测。这些源码及合成结果不关闭发布版 standalone 升级、最终安装产物或受支持平台执行门禁。下文 1.3.14 证据保留历史归属。

## 状态与问题

源码检查点 `0d353777bb054b9d5c9925f134dd63db7c316614` 通过普通 merge 纳入 main `19d3289f4818617efdf31ca46d4db0522da36f95`，包含已接受的输入/输出批次 #15067 和 Bun PTY #14046。49 项分发改动与现有依赖输入完整保留。该检查点的 macOS arm64 fresh build 和 typecheck 已通过。受影响 consumer、native、bundle 与安装版产品门禁分别记录在 [#14959](https://github.com/QwenLM/qwen-code/pull/14959)；源码构建成功不能代替安装产物验收。

历史证据继续绑定原源码和产物。候选 `e8192c18` 通过五种安装布局与 41 个不同实际产品场景，另有三个合成协议场景通过。更新夹具使用自有 0.0.0 克隆和候选 tarball，不代表两个正式发布版本之间的升级。后续 `7368b97` 的 22 个安装用例记录为 20 个功能通过与两个 Ink deny 已知差异；`61f4e5be` 的源码/运行时门禁早于本次 main 整合，均不能证明最终组合产物。原始失败、平台跳过及修正后的 harness 运行分别保留；最终 tarball 须重新实测 160 MiB 解包体积门禁。

原 strict 交互 `--json-file` 缺陷已有已接受的输出改动覆盖，但最终安装组合仍须独立执行输出回归。历史 serve 关闭失败需要在当前候选上重新刻画。Linux 原生 cgroup/bwrap/landlock、其他支持平台及正式发布版本升级仍是独立未结门禁。Windows ConPTY 诊断不代表安装版 Qwen 通过，也不改变固定 Bun 版本。这仍是显式选择 OpenTUI 的 POSIX npm 交付；整体 TUI 迁移完成及默认 renderer 切换须满足整体迁移门禁。

原 npm 分发基线排除了 `opentui-assets`，也没有私有 Bun 运行时。该基线中，Node
低于 26.4 时显式 OpenTUI 请求回退到 Ink；较新 Node 的 bundle 安装缺少启动
OpenTUI 所需的 native/parser 资产，而独立 Bun standalone preview 当时已包含运行时
与资产。npm/npx 应在不依赖全局 Bun、不改变默认 renderer 的前提下支持同一显式选择。

相关工作：

- [运行时总议题 #11607](https://github.com/QwenLM/qwen-code/issues/11607)。
- [Bun PTY #14046](https://github.com/QwenLM/qwen-code/pull/14046)，已合入审阅版本
  `2972234e`；新组合产物的 shell 一致性仍未验证。
- [R1 standalone 更新 #14934](https://github.com/QwenLM/qwen-code/pull/14934)。
- [发布执行权限 #14907](https://github.com/QwenLM/qwen-code/pull/14907)。

## 目标与边界

支持通过 npm 或 npx 安装后在 darwin-arm64、darwin-x64、linux-arm64、
linux-x64（glibc）上显式启用 OpenTUI。所有受支持 Node 版本调用符合条件的
npm 发布安装时，OpenTUI 都使用同安装的私有固定版本 Bun。Node 继续承担
npm launcher 与包管理器解释器角色，复用既有受监督 CLI relaunch。

不增加 `QWEN_TUI_RUNTIME`、新的平台包发布体系、运行时缓存、启动下载、
`PATH` 全局 Bun 搜索、编译应用或包管理器变更。不切换默认 renderer 或默认 Ink 运行时。
Windows、musl、整个 CLI 的 sandbox 镜像和外部 Node 专用宿主不进入新 handoff。
Node classic standalone 与 Node 源码调用保持 Node/Ink；Bun standalone preview
与受支持 Bun 源码调用可以显式选择 OpenTUI。standalone 运行时打包与更新解释器边界保留。

直接 `process.execPath` 审计还识别出
[#14134 的 c807de17](https://github.com/QwenLM/qwen-code/pull/14134) 与
[#14187 的 d14b2ad1](https://github.com/QwenLM/qwen-code/pull/14187) 中有界的剩余工作，
统一纳入现有 R3 交付。沙箱诊断、Mem0 MCP spawn 与 bundled hook 身份、cgroup
launcher，以及 bwrap/landlock relay/protected root 成对复用
`getJsInterpreterCommand`。保留原 payload、环境、reaper 与沙箱权限，并完整保留
四个相关回归文件。helper 在 npm/source/SDK 布局仍回退到调用者解释器。

三处原提议明确保留为例外：review Vitest 保留宿主解释器（容器中为镜像的 `node`）；
PEM loader oracle 与 TLS 信任探针保留 `process.execPath`，匹配实际 channel worker。
不能单独改变认证某个 worker 的探针运行时。
[运行时清单](bun-runtime-boundary.zh-CN.md) 同时记录迁移消费者和这些例外。
应用重启、默认运行时、protocol host 与 npm 的原 Node 身份不变。

## 模式与运行时选择

复用既有显式 `QWEN_TUI_RENDERER=opentui` 请求。在参数/设置解析后、创建
worktree、resume picker、鉴权、MCP 初始化和 renderer 初始化前执行 handoff。
与配置加载共享既有交互判定，不再次解析原始参数。显式 `-i` 为交互；否则带
query/prompt 为非交互，空 prompt 要求 stdin 为终端。
私有 Bun handoff 还要求 stdout 为终端，因此重定向输出保持调用者运行时。

OpenTUI 选择统一要求受支持的 Bun 运行时。为落实 TUI 迁移到 Bun 的目标，
退休此前 Node 26.4+ 原生 OpenTUI 例外。Node 无法 handoff 时，由既有共享门禁
让普通请求选择 Ink、strict 请求明确失败；原生 Node FFI 不再是替代 OpenTUI 路径。
不新增 fallback 状态、helper、依赖体系或运行时选择机制。本批另行更新既有私有 Bun 版本 pin。

| 调用方式                                                  | 运行时行为                                              |
| --------------------------------------------------------- | ------------------------------------------------------- |
| renderer 未设置、`ink` 或未知值                           | 保持既有运行时与 renderer 行为                          |
| 显式 OpenTUI、受支持交互 Node、受支持 npm 安装            | 经既有 supervisor 启动私有固定版本 Bun，包括 Node 26.4+ |
| 由 Node 运行的源码或 classic standalone                   | Node/Ink；strict OpenTUI 请求失败，无原生 Node 例外     |
| 由受支持 Bun 运行的源码或 standalone preview              | 显式 OpenTUI 使用 Bun，不进行 npm handoff               |
| 已运行于 Bun                                              | 保持运行时，不递归 handoff                              |
| screen reader，包括设置与 CLI 覆盖                        | 既有 Ink 能力回退；strict 请求失败                      |
| prompt/headless、pipe、help、version                      | 保持调用者运行时                                        |
| `serve`、`mcp`、managed bootstrap、ACP、SDK、IDE 协议宿主 | 保持既有运行时/协议路径                                 |
| dual-output 协议输入/文件或 JSON descriptor               | 不新增运行时 handoff                                    |
| 整个 CLI 的 sandbox 或已处于其中                          | 不使用宿主私有 Bun handoff，保持既有 sandbox 行为       |
| npm Node 位于 Windows、不支持的 CPU 或 Linux musl         | 不进行私有 Bun handoff；Node/Ink 或 strict 失败         |
| 缺少 optional runtime 或二进制不可执行                    | Node/Ink 回退；strict 显式请求失败并说明原因            |
| 不支持的继承 Node 运行时参数或禁用 relaunch               | Node/Ink 回退；strict 显式请求失败                      |

只向 Bun 传递本次已知启动方式支持的参数，不将 Node 内存调优参数或 Node loader
作为 Bun 参数转发。保留脚本参数、工作目录、环境来源、可信 launcher 身份和既有
禁止 relaunch 的标记。不能静默覆盖继承的禁用 relaunch 请求。

Bun spawn 失败通过既有 supervisor 报启动错误。Bun 进程启动后，native renderer
构造仍采用既有 Ink 回退/strict 失败策略，不在第二个运行时重放已启动的会话。

## 运行时与 npm 身份

相对于实际选中的已发布 CLI 安装解析官方平台包，不从用户工作目录解析。要求符合
发布 manifest/bin 布局、运行时平台包版本精确匹配，以及 `bin/bun` 为可执行普通文件。
开发/source 布局和 standalone manifest 不进入 npm handoff。

原 Node 解释器在模块启动时、设置或项目环境加载前记录，经受监督 handoff
传递，并仅用于 npm 工作。该身份必须关联当前安装，不能被 env 文件或
`settings.env` 值替换。既有 private provenance 排除规则也阻止伪造值进入嵌套子进程。
npm registry 查询、全局配置查询、managed update 安装与 smoke test、后台更新
worker 均使用此 Node 身份，不能从私有 Bun 路径推导 `npm-cli.js`。

保留 `QWEN_CODE_CLI`、managed npm root/pin 和 standalone 可信 launcher 校验。
退出码 44 必须到达原 Node wrapper，使既有更新/relaunch 逻辑能够选择新构建。
保留 IPC update-on-exit、终端进程组信号、stdin 所有权、清理与 supervisor
断连处理，不引入第二套 supervisor。

TTY 上的 Bun 解释器 handoff 使用现有私有 supervision 键的 `terminal` 值标记
子进程。子进程消费该标记，且只有真实当前或已断连的 IPC 通道才会触发处理。
当 Node 被终止但终端仍打开时，IPC 断连立即开始既有的有界清理，随后以 129
退出。其他终端 relaunch 保留原策略；pipe 和 ACP 保留 120 秒孤儿宽限。

该终端 Bun 子进程运行期间，Node supervisor 忽略 SIGINT，由子进程独立对前台
进程组信号实施既有的确认窗口。临时 listener 在关闭或失败时移除。只发给
supervisor 的 SIGINT 被忽略；终端进程组 SIGINT 和 raw Ctrl+C 输入是交互中断
路径。TERM/HUP 保留 Node 默认行为，不重复转发；即使只有父进程收到信号，
IPC 断连也会清理子进程。验收将保持 PTY keeper 存活的父进程 TERM/KILL 与
进程组 SIGINT、Ctrl+C 字节分开检查。

OpenTUI renderer 的进程退出 listener 排除 SIGINT，由共享交互确认 handler
处理该信号。第二次确认中断调用既有注册的 renderer 清理。保留 OpenTUI 0.5.10
的其他默认信号：SIGTERM、SIGQUIT、SIGABRT、SIGHUP、SIGPIPE、SIGBREAK 和
SIGBUS。仅禁用 renderer 的键盘 Ctrl+C handler 无法阻止进程级 SIGINT listener
在首次中断时销毁终端。因此验收必须证明首次前台进程组信号后输入仍可用且实际收到
模型响应，再检查双击退出。

## 包构建

生成的 npm manifest 包含四个精确固定在 Bun 1.4.4 的官方 `@oven` 平台 optional
依赖。直接使用 tarball 已含可执行文件的平台包，不使用带安装脚本的 `bun`
wrapper。因此支持 `--ignore-scripts`；`--omit=optional` 会明确使私有 Bun 不可用。

已发布包包含完整重定位资产根：parser worker、全部既有 grammar/SCM 文件、
`web-tree-sitter` wasm 和四个平台 native library。OpenTUI 0.5.10 从同一个
`OTUI_ASSET_ROOT` 解析所有 key；将公共资产和平台库拆开放而没有完整根会失败。
复用当前复制逻辑与 release staging 方式，native 包版本从 `pnpm-lock.yaml` 固定。

跨平台资产 staging 是允许联网的打包动作，不是安装或启动动作。在独占临时目录使用
`--ignore-scripts`，只复制声明的 native 文件，并清理临时内容。既有 desktop 调用者
使用内部 `--host-runtime` 准备模式，跳过通用 npm staging。最终复制出的 runtime
只保留所选 desktop 目标的 native library，也覆盖 `--skip-build` 复用已准备 npm
dist 的情况。公共 parser 资产保持完整，不裁剪原 dist。这样避免 Linux desktop
依赖扫描回归，并保留 Windows 目标资产。普通 bundle 构建保持原行为。
选择依据为 `desktopTarget()`，而不是构建机的 `process.arch`，因此交叉构建保留
目标平台库。

VS Code 扩展准备也使用 `--host-runtime`，保留既有 optional 依赖，不向嵌入的
`qwen-cli` 布局添加私有 Bun。复制后，平台 VSIX 仅保留显式 `VSCODE_TARGET`
对应的 OpenTUI native 库和公共 parser 资产，沿用既有 ripgrep 裁剪的目标校验。
universal、未显式指定目标和未知目标继续沿用原来的资产保留策略。
仅裁剪扩展副本，根 dist 与目标目录中既有依赖不受影响。sandbox 打包产生真实 npm
tarball，因此继续使用普通 npm 准备模式。

既有 npm 包解包大小 160 MiB 是硬门槛。必须测量真实准备后的 tarball，包含全部已发布
native library，不能从宿主专用 bundle 外推。optional Bun 依赖带来的安装大小另行
报告。真实产物超过门槛时，本方案尚不可交付，需调整范围；不能提高上限或删除必要资产
来获得通过。

保留 main 中 #14907 的 `npm publish` 执行权限保护。本分支不为同步旧底座修改
release workflow。验证使用 `npm pack` 和可信 main 的执行权限检查器，包含 vendored
ripgrep 与已安装 optional Bun executable，不重新引入 `pnpm pack` 发布路径。

## 依赖与风险

main 现已在 POSIX Bun 下选择 #14046 的 `qwen-bun-pty` 后端，并携带其 standalone
PTY 资产。本批保留该实现并加入 92d4b193 已回收主进程 guard；源码整合及此前的 pipe
回退验收都不能证明新安装产物的 shell 路径与 Ink/Node PTY 一致。真实进程与产物门禁
仍待执行。Windows Bun PTY 仍不支持。

单机可以检查四个平台归档内容，不能证明四平台 native 行为。macOS arm64 执行证据
必须与 Linux/x64 或 Windows 检查分开记录。此前 Node 26.4+ 原生路径已作为
兼容例外退休，不再是待选择的政策。官方 Node 26.4.0 运行时已取得并核验，
以其为 launcher、使用同一安装私有 Bun 1.4.4 的一项真实 npm 安装版 strict OpenTUI 用例已通过；
仅注入版本的单测不代表产品证据。screen reader、sandbox、Windows/musl
与 PTY 依赖仍是独立的整体迁移门禁。

运行时参数、managed npm 更新、符号链接/npm-prefix 安装与 optional 依赖省略
是最高风险边界。缺少 parser worker/grammar 可能静默丢失高亮；仅检查版本不能
证明 CLI 加载或 native renderer 启动。

## 验证与验收

先用全局 CLI 建立模式/运行时基线，再做产品 E2E。详细计划和结果保存在
`.qwen/e2e-tests/`。所有测试使用独占临时 HOME、QWEN_HOME、npm prefix/cache
和 shell 配置路径。

1. 单测覆盖完整模式表、设置优先级、运行时参数、包身份、版本/执行权限校验，以及原
   Node 的 npm 调度。
2. 打包测试拒绝公共资产不完整、任一目标 native 缺失、版本不匹配和超过 160 MiB
   的产物；断言发布文件与精确 optional 依赖版本。执行真实 IDE 准备、metadata
   生成与复制链路，仅替换 npm 构建/安装进程：确保 VSIX 安装器不会收到 Bun
   optional 依赖，既有 optional 依赖与 universal 安装参数保留，目标裁剪保留
   公共资产和可复用源目录。
3. 对冻结源码提交执行 build、typecheck、bundle 与 focused tests。
4. 无全局 Bun 时安装真实 `npm pack` tarball，验证本地 npm prefix 与 npx cache、
   普通安装及 `--ignore-scripts`。strict OpenTUI 必须加载 native renderer 和
   parser worker，产生实际高亮输出。
5. 覆盖 `--omit=optional`、运行时缺失/不可执行、grammar/native 缺失、只读安装和
   当前目录存在伪造 Bun，分别验证 fallback 与 strict 失败。
6. 在原 Node 下执行真实 npm registry/config 子进程、managed update staging、
   退出码 44 重启链、IPC update-on-exit、SIGINT/SIGTERM 和无残留进程的退出。
   synthetic fixture 必须明确标注。
7. 验证 headless/协议/help/version 保持 Node 与原输出 framing。Node 26.4+ 须验证
   合格 npm handoff，以及每种拒绝最终选择 Ink 或 strict 失败，包括继承 FFI 参数；
   任何情况都不能选择原生 Node/OpenTUI。验证 Node 源码/classic standalone 保持 Ink，
   受支持 Bun 源码/preview 可以选择 OpenTUI。保留 screen reader、Windows/musl 与
   sandbox 对照并记录平台限制。首项真实 Node 26 安装版 strict smoke 已通过；
   六项拒绝负控已在该历史产物上通过，本次整合产物及其他安装布局仍待实际执行。
8. 保留 npm 发布执行权限，记录 tarball hash、解包大小、optional runtime 安装大小、
   Node/Bun 版本与精确 commit。
9. 使用不同的私有解释器路径验证整合调用点，覆盖成对的 Mem0 身份拒绝、literal
   payload 参数与 protected root 重叠拒绝。真实 Linux cgroup membership/reaping
   和 bwrap/landlock 执行仍是独立门禁，mock 断言不能关闭它们。

执行前不标记 PASS。平台内容检查不替代对应平台 native 测试，本交付不关闭总体
运行时迁移或 Ink 一致性总议题。

## 永久 npm 安装回归

一个专用安装测试套件共享当前候选的一次全新 `prepare:package`、真实 Node26.4/npm pack，以及普通 optional 依赖解析的自有目录 `install --ignore-scripts`。它核对同一 tarball 全部发布文件的内容和权限、160 MiB 解包上限，以及独立安装的私有 Bun 和 native 库；不以 checkout bundle、全局 Bun、preload 插桩或模拟包管理器结果替代。

九个顺序用例覆盖 strict 安装版 native/parser 启动、一次闭合模型请求和自然退出；禁用 relaunch、缺失自有 Bun、继承 FFI 参数各自的普通 fallback 与 strict 拒绝；以及原 Node 下的真实 npm registry 子进程。身份观察器对 synthetic loopback registry 委托执行未修改的真实 npm。启动与退出记录必须关联同一个原 Node/无 Bun 进程，所需查询真实退出零后，才检查前台 Bun/native 与正常 UI。它不证明 registry 认证或实际更新安装。新增一案在同一安装产物上，由真实 Node 独立写入旧 AES-GCM 扩展密文及选择器，再直接执行安装包私有 Bun 的公共设置读取，在 USER 正确、缺失和错误三种环境下均要求真实退出零、敏感标记存在、无明文输出且原密文/权限和安装目录不变；固定 keychain 文案不证明 OS keychain。该永久回归仍需实际执行。

专用配置只选择本套件，单 worker、无重试、未处理错误致命，每案 120 秒。共享 setup 上限为 1560 秒：prepare 600、pack 300、install 600，加有界核验；清理保留首个失败。现有 TUI workflow 增加独立的 60 分钟安装 job，原 45 分钟源码 parity job 不变。默认 integration collection 排除 installed 目录，避免普通测试隐式安装软件包。

必需 CI 首先使用 hosted Ubuntu Linux x64 GNU 与 Node26.4；Darwin arm64 作为单独本机结果。Linux 进程身份和 native 映射使用 `/proc`，Darwin 使用 `ps` 与 `lsof`，不能互借宿主观察结果。其他支持的 POSIX 宿主执行前仍为 NOT_RUN。Windows 和 musl 不是 strict npm OpenTUI 成功目标。必需工具链、资产、观察权限或网络缺失是 setup 失败，不能 skip 判绿。证据按唯一 run/attempt 目录保存实际 checkout、归档、安装、原始 PTY/HTTP、自然退出与自有进程清理。

这些用例仍属于运行时后续 PR #15387。历史 ignored 手工结果仅校准合同，不代表新永久套件或 Linux adapter 已通过。Standalone 正式发布升级/回滚、global/npx/symlink/只读布局、其他目标平台与真实 registry 认证仍是独立义务。
