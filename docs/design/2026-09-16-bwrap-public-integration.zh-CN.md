# bwrap 工具执行模式正式接入

[English](2026-09-16-bwrap-public-integration.md) | [简体中文](2026-09-16-bwrap-public-integration.zh-CN.md)

## 状态与范围

2026-09-19 更新的实现候选。本次变更是 bwrap 交付的第三阶段：叠加在 runtime 集成阶段之上，开放 CLI 配置边界并退役整 CLI bwrap。已合并的执行底座继续提供传输与生命周期能力。Landlock 和公开 Linux x64/aarch64 验收 workflow 分别留到后续独立变更。

首个公开入口支持普通 headless CLI 和两套终端 UI。受支持的直接 shell 入口与内置工具必须共享不可变 runtime 策略。不支持的集成明确拒绝：带委托文件系统/会话执行的 ACP/serve、web terminal、可执行扩展/hooks/discovery/MCP/LSP、自动 worktree 管理、外部 agents 和推测文件合并。仅隐藏模型工具声明不能证明集成安全。这收窄统一设计的首个公开前端契约：ACP/serve 需要完整的 selected-runtime 与委托契约才可启用；在此之前必须拒绝新策略，不能在宿主执行。

## 操作者策略与迁移

`tools.executionSandbox` 仅来自 User、SystemDefaults、System 或可信编程式 runtime 构造。必填字面量字段为 `filesystem: read-only | workspace-write` 和 `network: open | closed`；可选 `backend: auto | bwrap` 默认为 auto，当前唯一候选为 bwrap。工作区设置不能启用、关闭或替换此对象，包括把父对象替换为标量。System 策略按完整对象优先。拒绝未知字段/值及非法对象。模型参数、项目 dotenv、普通 include-directories 和扩展设置不产生授权。Bare/safe 可省略普通配置，但不能关闭操作者沙箱策略。

策略约束规范化准入工作区、受保护的安装/全局/runtime 目录及每次执行的 scratch。在受支持工具执行前进行固定真实 bwrap 探测；探测或实际设置失败都拒绝执行，不重放、不回退整 CLI。已有 Config 的策略保持不可变，需构造新 runtime 才改变；设置要求重启。报告请求的选择方式、实际 bwrap 后端、文件系统与命令网络策略。不增加 Landlock 占位值或环境开关。

有效旧 `--sandbox bwrap`、`tools.sandbox: bwrap`、`QWEN_SANDBOX=bwrap`、等价编程式选择与继承 `SANDBOX=bwrap` 均在执行前报带迁移示例的错误。新工具策略不能与旧容器/Seatbelt 选择、旧网络/代理变量或继承的旧沙箱标记组合。删除 bwrap CLI 重启实现、根/状态授权及重入 helper，保持 Docker/Podman/Seatbelt 行为。保留 `qwen sandbox` 参数转发与失败非零退出；其原生报告、探测和命令运行使用新执行边界。检查报告明确说明宿主模型/认证/会话流量不受命令网络约束。

## 执行与前端边界

Ink/OpenTUI `!`、提示词 shell 插值及 Monitor 接入 runtime shell executor。不再为了检测 cwd 变化而创建宿主临时文件；受约束命令继续无状态。模型 Shell 和 Read/Write/Edit 保留已验证的 worker 与传输。只有策略在全部构造/恢复路径保持不变时，才准入嵌套 Code Mode/agents；在设置前拒绝自定义 executor、hooks、MCP 添加及 worktree/working-dir 越界。未迁移的写入/进程工具不注册，直接调用未支持 adapter 也拒绝。

非 bare 初始化必须在启动前抑制未支持的宿主副作用：推测合并、仓库 hook/worktree 清理、自动 skill/team-memory Git 操作、扩展发现和可执行 hooks。UI 渲染不能在宿主执行模型选择的 Mermaid/图片 helper。自定义状态栏命令与 GitHub 查询接入 runtime shell 或在此模式禁用。纯内存渲染及受保护认证/会话/历史记账继续属于可信 runtime。

策略属于每个 Config，不写进进程全局环境标记。派生 runtime 不能扩大根，审批/YOLO 不能关闭约束，持久化 agent flags 不能替换策略。ACP/serve 启动及委托会话路径在监听器、子进程设置或用户 payload 之前拒绝未支持模式；未启用时保留原 ACP/serve 行为。

## 影响代码与兼容性

Core 覆盖策略准入、Config 初始化/registry、Monitor/嵌套调度及未支持副作用 gate。CLI 覆盖设置 schema/可信合并、启动、终端 shell/进程渲染、诊断、原生 sandbox 命令及旧实现删除。ACP/serve 在最早可得的策略准入处检查，不重构 runtime 归属。打包 worker 沿用已有验证实现。文档同时给出配置使用方法、未支持能力及整 CLI bwrap 的明确破坏性迁移。

## 验证与验收

源码修改前，在隔离 HOME/QWEN_HOME/runtime、合成 loopback 模型凭据、user/system/workspace 设置及 TUI 会话下跑全局 qwen 基线，记录此前忽略新公共设置与旧选择行为。候选 E2E 必须启动真实公共 CLI，不能只用内部 launcher。

真实 Linux 验证 headless、两套 TUI shell、提示词插值、Monitor 和受支持嵌套调用：工作区可写、兄弟目录写入/网络按策略拒绝、宿主模型/会话持久化成功、YOLO 仍受只读约束。测试操作者优先级、恶意 workspace 父值、bare/safe 保留策略、后端不可用、继承标记迁移、未支持启动和无 payload sentinel。保留仍适用的此前 31 组 runtime / 34 组 adapter 检查，有意更新历史断言。缺少内核前提应失败，不能跳过后绿色。

要求 build、typecheck、bundle、定向包单测、lint/format、最终源码/产物检查及两轮干净自审。精确已测和未支持入口记录在 `.qwen/e2e-tests/bwrap-public-integration.md`。本 PR 不增加 Landlock、公开 Linux 验收 workflow 或可选 adapter 扩展。

操作者设置文件解析失败（包括 JSON 损坏）时拒绝启动，不能将可能存在的沙箱策略重置为空。用户显式触发的 `/doctor` 等管理诊断、`/memory` 中主动打开/编辑的记忆文件或目录，以及 `/skills` 中的设置修改仍属于可信宿主操作。这些管理入口不向模型注册为可调用命令；在 `/skills` 选中技能只填入输入框。提交 `/技能名` 时明确拒绝当前模式，在此之前不应用 hooks/权限、不写入或清除参数文件、不更新项目使用记录。模型 Skill 工具也保持未注册。自动记忆/技能维护继续禁用，显式设置修改不能重新启用当前沙箱 runtime 中被禁用的自动执行路径。工作树/Arena 管理、文件恢复与宿主 Git diff 预览拒绝执行；仅对话历史回退继续可用。IDE 自动探测、提示与连接也禁用。sandbox 单命令子命令保留原始参数、转发重定向的标准输入，并逐字节保留标准输出与标准错误；交互式 PTY 命令使用终端 `!`。

## 历史证据与当前验收

此前的合并原型在 Linux aarch64 7.0.0-31-generic、Node 22.22.1、bwrap 0.11.1 和 Bun 1.3.13 环境通过了公开 CLI 60 组、runtime 31 组及 adapter 34 组真实 Linux 测试。这些证据确定了拆分边界和预期行为，但属于较早的合并 head，不能替代本 PR 精确 head 的验证。

本阶段要求当前叠加 head 在 macOS 上通过 core 与 CLI build、typecheck、定向测试、lint 和格式检查，并继续通过仓库 CI。精确 head 的 Linux x64/aarch64 强制约束留给第四阶段公开验收 workflow。Windows 尚未实测。详细历史证据和 fixture 哈希继续记录在 `.qwen/e2e-tests/bwrap-public-integration.md`。
