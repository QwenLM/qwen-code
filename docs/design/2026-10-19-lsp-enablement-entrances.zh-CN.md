# LSP 启用入口

[English](./2026-10-19-lsp-enablement-entrances.md) | [简体中文](./2026-10-19-lsp-enablement-entrances.zh-CN.md)

## 状态

在新增 `tools.lspEnabled` 的变更中实现。LSP 仍为实验性，默认关闭。

## 问题

在本变更之前，LSP 只能通过 `--experimental-lsp` 启用。最需要代码智能的客户端自行构造守护进程的参数列表，无法传参：Desktop 客户端的 argv 在 Rust 中固定。该功能因此已经发布却在那些宿主中不可达，`/lsp` 甚至不会为它们注册。

第二个入口会改变第一个入口的含义。`experimentalLsp` 声明为 `default: false`，因此内部 Config 把参数传为 off 与从未提及该参数无法区分。一旦设置项可以启用 LSP，所有原本依赖“参数为 off”作为拒绝手段的宿主自有 helper Config 都会启动一整套它们永远用不到的语言服务器。

## 入口与优先级

一个解析函数为所有表面给出答案：

1. `QWEN_CODE_DISABLE_LSP=1` —— 运维者禁用开关，压过一切。
2. `--experimental-lsp`。
3. `QWEN_CODE_ENABLE_LSP=1`。
4. `tools.lspEnabled === true`。

该设置仅从用户、系统与系统默认层读取。`tools.lspEnabled` 列入 `WORKSPACE_RESTRICTED_SETTINGS`，因此工作区取值在合并前被剥离、被报告为已忽略，并由守护进程的设置路由拒绝写入。理由是作用域而非偏好：开启 LSP 会让会话以用户自身权限启动语言服务器，而检出的仓库不是授权表面。

环境变量对遵循 `tools.workflowsEnabled` 先例：严格 `=== '1'` 比较，且禁用开关先求值。两个键都列入项目 `.env` 排除表，因此仓库的环境文件既不能开启该功能，也不能清除该开关。

取值仅在启动时读取（`requiresRestart: true`）。原生服务及其子进程在 Config 构造期间建立，`/lsp` 在命令加载时注册，因此会话中途修改无法给一个启动时未启用 LSP 的会话接上客户端。

## 宿主拒绝

拥有某个 Config 且永不使用 LSP 的宿主设置运行时专用的 `hostPolicy.lspDisabled: true`。它刻意不来自 argv、settings 或环境：只有构造该 Config 的内嵌宿主才能拒绝该服务，且该拒绝必须同时压过环境变量对与设置项。

`lspDisabled` 只接受字面量 `true`，并且本身从不经由位置参数列表传递——`hostPolicy` 是 `loadCliConfig` 的第十个位置参数。

## 宿主自有 Config

每个宿主自有 helper Config 都必须传 `lspDisabled: true`。这条规则正是下表存在的原因：遗漏是静默的，因为该 Config 仍能构建、仍能完成自己的用途。

| 调用点                                                            | 用途                              | 拒绝 LSP |
| ----------------------------------------------------------------- | --------------------------------- | -------- |
| `packages/cli/src/llm.tsx` —— 沙箱前置 `partialConfig`            | 在 `start_sandbox` 交接前校验鉴权 | 是       |
| `packages/cli/src/llm.tsx` —— 主会话 Config                       | 交互式或 ACP 会话                 | 否       |
| `packages/cli/src/acp-integration/acpAgent.ts` —— 工作区 MCP 发现 | 仅发现 MCP 服务器                 | 是       |
| `packages/cli/src/acp-integration/acpAgent.ts` —— 会话 Config     | 宿主实际运行的会话                | 否       |
| `packages/cli/src/serve/hosted-harness-model.ts`                  | 一次宿主模型轮次                  | 是       |
| `packages/cli/src/serve/hosted-hook-model.ts`                     | 一次宿主钩子操作                  | 是       |
| `packages/cli/src/serve/hosted-workflow-turn.ts`                  | 一次宿主 workflow 轮次            | 是       |
| `packages/cli/scripts/opentui-command-parity.ts`                  | 只读的命令面 parity 探针          | 是       |

新增的生产 `loadCliConfig` 调用点必须判定自己属于哪一行。若它的存在意义是不运行任何工具，它就有义务传守卫。

## 守护进程兼容性

`evaluateManagedCompatibility` 在**做出决定的地方**解析 LSP：在它已经为其余规则读取的设置快照与有效环境之后，并把转发的 `--experimental-lsp` 参数作为 flag 入口传入。没有任何按 runtime 缓存的字段，因此设置写入、运行环境替换与 model-provider 重载都会进入下一次评估，也不存在启动时冻结的值。运维者禁用开关由同一个解析函数应用，所以转发的 flag 不会压过 `QWEN_CODE_DISABLE_LSP=1`。

相对子进程，解析仍可能过度上报：某个会话宿主以自身条件拒绝 LSP（只读 agent host、SSH 工作区、临时工作区、bare 或 safe 模式）时，它并不会启动服务器，却仍被延期。这是安全方向——失去一次卸载，绝不认证一个会启动进程的会话。设置层无法读取时返回 `unknown`，同样绝不会选择托管引擎。

## 会话侧宿主模式

`loadCliConfig` 对只读 agent host、SSH 工作区、临时工作区、bare 模式与 safe 模式整体拒绝 LSP。safe 模式是本变更新增的一项：它的存在意义正是不信任环境来源的文件状态，而工作区 `.lsp.json` 正是此类状态。

## 验证

- 单元：解析函数优先级；仅有设置项而无参数时启用服务；禁用开关压过参数、环境变量与设置项；宿主拒绝压过设置项与 `QWEN_CODE_ENABLE_LSP=1`；safe 模式拒绝设置项入口；工作区取值被剥离并给出警告。
- 接线：`src/` 下每个受守卫的宿主自有 Config 断言其 `hostPolicy` 实参；`scripts/opentui-command-parity.ts` 是手工运行的探针，没有测试。LSP 启用状态在评估器内部由它所读取的快照解析，因此上述单元用例覆盖了 runtime 构造完成之后才到达的设置写入。
- 手工：以设置开启、不带参数创建守护进程会话，然后读取 `GET /session/:id/lsp`。

## 后续项

- `Config.shutdown()` 不会停止 LSP 客户端，因此守护进程 spawn 的会话把语言服务器留给进程退出回收。另行跟踪；修复需要扩宽 core 的 `LspClient` 接口与 `Config.shutdown`。
- `llm.tsx` 中启动期的执行沙箱守卫仍只读参数；它经由 `loadCliConfig` 失败关闭，但两个守卫回答的是不同问题。
- `docs/design/hot-reload/lsp-runtime-reinitialization.md` 仍把参数描述为唯一开关。修正它必须补齐其缺失的简体中文版，因此另起纯文档变更。
