# Agent View：左方向键转入后台与会话列表

[English](2026-11-06-agent-view-left-arrow-roster.md) | [简体中文](2026-11-06-agent-view-left-arrow-roster.zh-CN.md)

状态：已实现，并已在 Windows 和 Linux 上验证（见“验证”）。

## 问题

Agent View 的后端（supervisor、PTY worker、会话生命周期）已经合入，但发布版本中没有任何入口能用到它。CLI 入口不解析 supervisor 和 PTY host 的内部参数，supervisor 子进程会因为未知参数直接退出。会话列表界面和 `qwen agents` 命令在尚未合入的叠加 PR #7802 和 #7803 中，这两个 PR 已无法干净地应用到 `main`。用户想在终端里同时运行多个会话、并看到哪个会话在等自己，目前做不到。

## 现状

- supervisor 运行时、PTY host、worker sideband、roster 存储和展示层都已在 `main` 上，并有单元测试。
- CLI 入口没有处理 `--internal-agent-view-supervisor` 和 `--internal-agent-view-pty-host`。
- worker 从不发送 supervisor 等待的 `ready` 事件，所以接管会话会在 15 秒后超时。
- 没有任何按键或命令能把当前会话移入 Agent View。

## 目标

- 在空输入框上按左方向键，把当前会话转入后台，并打开全屏的后台会话列表，行为与 Claude Code 相同。
- 列表按状态分组（Needs input、Working、Completed、Failed，以及 Pinned），每一行显示标题、一行摘要、最新绑定的 PR 和时长。
- 在列表中：Space 查看会话并可直接回复，Enter 进入完整会话，在已进入会话的空输入框按左方向键返回列表，Up/Down/PgUp/PgDn 移动选择，Ctrl+T 置顶，Ctrl+R 重命名，Ctrl+X 停止，再按一次 Ctrl+X 删除。
- 在列表输入框中输入提示词即可启动一个新的后台会话。
- 在 Windows、Linux 和 macOS 上都能使用。

## 非目标

- 在一轮对话进行中转入后台。接管会在 supervisor 管理的 PTY 中重新启动会话，进行中的对话会丢失，因此命令会拒绝，直到会话空闲。
- OpenTUI 版本的会话列表。OpenTUI 渲染器会提示不支持转入后台。
- #7802 中的 `qwen --bg` 和 managed-resume 保护。它们与本流程无关，可以单独跟进。

## 设计

### 入口与开关

全部功能受 `experimental.agentView` 控制（默认 `false`）。关闭时，左方向键的行为与之前完全相同。开启时，在空输入框上按左方向键（无修饰键，且不在 shell 模式、反向搜索、补全或附件模式中）会提交 `/background`（别名 `/bg`），因此按键和命令共用同一组检查：没有正在进行的对话，没有待确认的工具或命令，没有前台 shell，没有排队的提示词，并且会话已经保存。`/background` 使用与 `/restore`、`/logout` 相同的“当前提交”空闲判断，因为通用的空闲标志在任何斜杠命令运行时都显示为忙碌。

`qwen agents`（或 `qwen agents list`）在 TTY 中打开会话列表，否则输出文本列表；`attach`、`logs`、`stop`、`kill`、`respawn`、`rm` 和 `daemon` 是子命令，原有的 `join` 子命令保留。

### 把终端交给会话列表

转入后台时会刷新对话记录，请求 supervisor 接管会话，关闭当前会话并启动会话列表。在 Windows 上，由正在退出的会话通过嵌套 `spawnSync` 启动列表行不通：被阻塞的父进程会继续读取控制台输入，列表收不到按键。因此当前会话通过已有的 IPC 通道把列表的命令行发给 relaunch supervisor 后退出；supervisor 的 stdin 已经暂停，由它以继承的 stdio 启动列表。如果没有 relaunch supervisor（例如在 Linux 上进程被原地替换），会话回退到 `spawnSync`。

正在退出的会话会清空控制台标题。在 Windows 上使用 Node 22 时，下一个读取空标题的进程会触发 libuv 断言而中止，所以 relaunch supervisor 在启动列表前会先设置一个标题。

### Worker

worker 在加载完配置后立即发送 `ready`、报告 `idle` 并启动心跳。在 worker 中运行时，界面在每次状态变化时上报状态，并每 250 毫秒轮询 sideband，处理回复、回答、停止和重绘请求。进入会话时 supervisor 会排队一个重绘请求；worker 使用与唤醒/SIGCONT 相同的方式重绘，因为在 terminal-buffer 模式下 `refreshStatic` 不输出任何内容，否则刚进入的终端在第一次按键前会一直是空白。

### 每一行的内容

- 标题：重命名的标题，否则使用会话的第一条用户提示词。
- 摘要：每轮对话结束后，worker 请模型（配置了快速模型时用快速模型，否则用会话模型）用一行描述发生了什么，并用它替换原始的最后一行输出。会话在等待回答问题时保留原始问题，因此“需要输入”的判断不变。
- PR 标签：会话 PR 记录中的最新一项，例如 `#221` 或 `#221 merged`。
- 失败的会话单独成组，排在 Completed 下方，标题栏中单独计数。

## 决策与理由

- 复用上游的会话列表而不是重写：它已经支持查看、回复、置顶、重命名和停止/删除，并与 `qwen sessions ps` 使用同一套术语。
- 保留 `main` 上的后端，只移植界面和命令：`main` 包含之后的后端修复（例如 Windows PTY 使用的 ConPTY 后端）。
- 通过 relaunch supervisor 交接终端，而不是修复退出进程中的控制台读取：supervisor 在每次启动时都已经正确地完成这种交接。
- 用 side query 生成摘要，而不是用文本规则：最后一行输出常常是表格行或代码行。

## 风险

- 每个后台会话每结束一轮对话，摘要会多一次模型请求。只在 Agent View worker 中运行。摘要是尽力而为的：请求失败或没有返回内容时，这一行保留原始的最后一行输出。
- 在刚启动的 worker 启动的几秒内按 Ctrl+X，可能被记录为失败而不是停止，因为停止和 worker 退出在 supervisor 的 ready 等待中存在竞争。

## 验证

- 单元测试覆盖左方向键绑定、`/background` 的空闲例外、relaunch 交接会话列表、PgUp/PgDn、Failed 分组和摘要清理，以及移植过来的会话列表、命令和后端测试。
- 在真实伪终端中连接在线模型做端到端测试：Windows（源码构建使用 Node 24，独立安装包使用自带的 Node 22）和 Linux（WSL Debian 13，Node 22）。流程为：对话，按左方向键进入列表，查看并回复，进入会话并立即显示画面，按左方向键返回，从列表启动会话，重命名，置顶，停止和删除。

## 验收标准

- 开关关闭时，左方向键和所有现有按键的行为与之前相同。
- 开关开启时，在空闲的空输入框上按左方向键会打开会话列表，会话继续在后台运行。
- “目标”中列出的每个按键在 Windows 和 Linux 上都能使用。
- 进入会话时立即显示画面。

## 待定问题

- 左方向键是否也应该能像 Claude Code 一样把进行中的对话转入后台？这需要 worker 接管正在进行的对话，而不是恢复对话记录。
- 是否应该把 daemon 拥有的会话（`qwen serve`）纳入会话列表？见 `docs/plans/2026-09-04-background-agent-surfaces.md`。
