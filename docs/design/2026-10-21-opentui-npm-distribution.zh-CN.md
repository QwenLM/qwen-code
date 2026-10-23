# POSIX npm OpenTUI 分发

[English](2026-10-21-opentui-npm-distribution.md) | [简体中文](2026-10-21-opentui-npm-distribution.zh-CN.md)

## 状态与问题

源码检查点 `0d353777bb054b9d5c9925f134dd63db7c316614` 通过普通 merge 纳入 main `19d3289f4818617efdf31ca46d4db0522da36f95`，包含已接受的输入/输出批次 #15067 和 Bun PTY #14046。49 项分发改动与现有依赖输入完整保留。该检查点的 macOS arm64 fresh build 和 typecheck 已通过。受影响 consumer、native、bundle 与安装版产品门禁分别记录在 [#14959](https://github.com/QwenLM/qwen-code/pull/14959)；源码构建成功不能代替安装产物验收。

历史证据继续绑定原源码和产物。候选 `e8192c18` 通过五种安装布局与 41 个不同实际产品场景，另有三个合成协议场景通过。更新夹具使用自有 0.0.0 克隆和候选 tarball，不代表两个正式发布版本之间的升级。后续 `7368b97` 的 22 个安装用例记录为 20 个功能通过与两个 Ink deny 已知差异；`61f4e5be` 的源码/运行时门禁早于本次 main 整合，均不能证明最终组合产物。原始失败、平台跳过及修正后的 harness 运行分别保留；最终 tarball 须重新实测 160 MiB 解包体积门禁。

原 strict 交互 `--json-file` 缺陷已有已接受的输出改动覆盖，但最终安装组合仍须独立执行输出回归。历史 serve 关闭失败需要在当前候选上重新刻画。Linux 原生 cgroup/bwrap/landlock、其他支持平台及正式发布版本升级仍是独立未结门禁。Windows ConPTY 诊断不代表安装版 Qwen 通过，也不改变固定 Bun 版本。这仍是显式选择 OpenTUI 的 POSIX npm 交付；整体 TUI 迁移完成及默认 renderer 切换须满足整体迁移门禁。

当前 npm 发布清单排除了 `opentui-assets`，也没有私有 Bun 运行时。Node 低于
26.4 时，显式 OpenTUI 请求回退到 Ink；较新 Node 的 bundle 安装仍缺少启动
OpenTUI 所需的 native/parser 资产。独立的 Bun standalone preview 已包含运行时
与资产。npm/npx 应在不依赖全局 Bun、不改变默认 renderer 的前提下支持同一显式选择。

相关工作：

- [运行时总议题 #11607](https://github.com/QwenLM/qwen-code/issues/11607)。
- [Bun PTY #14046](https://github.com/QwenLM/qwen-code/pull/14046)，已合入审阅版本
  `2972234e`；新组合产物的 shell 一致性仍未验证。
- [R1 standalone 更新 #14934](https://github.com/QwenLM/qwen-code/pull/14934)。
- [发布执行权限 #14907](https://github.com/QwenLM/qwen-code/pull/14907)。

## 目标与边界

支持通过 npm 或 npx 安装后在 darwin-arm64、darwin-x64、linux-arm64、
linux-x64（glibc）上显式启用 OpenTUI。Node 继续承担 npm launcher 与包管理器
解释器角色；交互 renderer 需要私有 Bun 时复用既有受监督 CLI relaunch。

不增加 `QWEN_TUI_RUNTIME`、新的平台包发布体系、运行时缓存、启动下载、
`PATH` 全局 Bun 搜索、编译应用或包管理器变更。不切换默认 renderer/runtime。
Windows、musl、整个 CLI 的 sandbox 镜像和外部 Node 专用宿主不进入新 handoff。
既有 standalone 运行时选择与更新行为保留。

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

| 调用方式                                                  | 运行时行为                                        |
| --------------------------------------------------------- | ------------------------------------------------- |
| renderer 未设置、`ink` 或未知值                           | 保持既有运行时与 renderer 行为                    |
| 显式 OpenTUI、交互 Node 低于 26.4、受支持 npm 安装        | 经既有 supervisor 启动私有固定版本 Bun            |
| 显式 OpenTUI、Node 26.4 及以上                            | 保留 Node/OpenTUI 路径；既有 FFI 要求仍适用       |
| 已运行于 Bun                                              | 保持运行时，不递归 handoff                        |
| screen reader，包括设置与 CLI 覆盖                        | 既有 Ink 能力回退；strict 请求失败                |
| prompt/headless、pipe、help、version                      | 保持调用者运行时                                  |
| `serve`、`mcp`、managed bootstrap、ACP、SDK、IDE 协议宿主 | 保持既有运行时/协议路径                           |
| dual-output 协议输入/文件或 JSON descriptor               | 不新增运行时 handoff                              |
| 整个 CLI 的 sandbox 或已处于其中                          | 不使用宿主私有 Bun handoff，保持既有 sandbox 行为 |
| Windows、不支持的 CPU 或 Linux musl                       | 不进行私有 Bun handoff                            |
| 缺少 optional runtime 或二进制不可执行                    | Node/Ink 回退；strict 显式请求失败并说明原因      |
| 不支持的继承 Node 运行时参数                              | 保持原 Node 路径；strict 显式请求失败             |

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

生成的 npm manifest 新增四个精确固定在 Bun 1.3.14 的官方 `@oven` 平台 optional
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
必须与 Linux/x64 或 Windows 检查分开记录。保留 Node 26.4 的 Node/OpenTUI 是
本批有意采用的兼容选择；后续全部 TUI 迁移 Bun 的里程碑仍需覆盖这些 Node 版本、
screen reader、sandbox、Windows/musl 与 PTY 依赖。

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
7. 验证 headless/协议/help/version 保持 Node 与原输出 framing；Node 26.4+、
   screen reader、standalone、Windows 与 musl 排除项有明确回归覆盖和平台执行限制。
8. 保留 npm 发布执行权限，记录 tarball hash、解包大小、optional runtime 安装大小、
   Node/Bun 版本与精确 commit。
9. 使用不同的私有解释器路径验证整合调用点，覆盖成对的 Mem0 身份拒绝、literal
   payload 参数与 protected root 重叠拒绝。真实 Linux cgroup membership/reaping
   和 bwrap/landlock 执行仍是独立门禁，mock 断言不能关闭它们。

执行前不标记 PASS。平台内容检查不替代对应平台 native 测试，本交付不关闭总体
运行时迁移或 Ink 一致性总议题。
