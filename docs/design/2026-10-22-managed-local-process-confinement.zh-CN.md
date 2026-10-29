# Managed local-process 隔离提案

[English](2026-10-22-managed-local-process-confinement.md) | [简体中文](2026-10-22-managed-local-process-confinement.zh-CN.md)

## 状态与现状

这是 [#15081](https://github.com/QwenLM/qwen-code/issues/15081) 的设计提案，不是实现，也不是 Runtime 资格验证结果。当前 Managed `local-process` 路径使用 worker 的宿主权限运行 Workspace 文件和 Shell 工具。Workspace 根目录属于可信部署数据，`isolationClass` 只命名作用域，并没有强制文件系统边界。

仓库已经有 Linux bubblewrap（`bwrap`）执行底座以及 Runtime Shell/File 阶段。现有策略使用只读宿主根视图，并明确不承诺读取保密性。因此，直接为 Managed Agent 开启它仍会允许跨 Workspace 读取。Issue [#14667](https://github.com/QwenLM/qwen-code/issues/14667) 负责独立的 cgroup 单元、`setsid`/双重 fork 进程约束和 Broker 可见的空证明；本提案消费这一契约。

## 目标

- 为 Linux `local-process` provisioner 增加由运维控制、带版本的 opt-in；未启用时保持现有行为不变。
- 让所有受支持的 Managed 文件和 Shell 副作用都经过已选定且已正向验证 Managed bwrap 档案的 Runtime。
- 限制已准入 Workspace 的文件系统和进程副作用；客户端路径、`includeDirectories`、符号链接或模型参数不能扩大边界。
- 复用 #14667 的进程生命周期契约，提供有类型且用户可见的拒绝，不静默降级到宿主重试。

## 范围边界

首个档案覆盖 Managed Workspace 的 Read/Write/Edit 和前台 Shell。MCP server、Hooks、可执行扩展、LSP、自定义 executor，以及使用不同 executor 的嵌套 agent，在具备等价隔离路径前都必须拒绝。隐藏模型工具声明不能替代拒绝未受约束的路径。

首个 opt-in 的范围是单个 Workspace，并且采用 all-or-nothing。一个选定的
Workspace 要么所有准入路径都使用已获资格的档案，要么在执行 payload 前明确拒绝或
关闭该档案。无法使用同一隔离边界的 MCP、Hook、LSP、自定义 executor 或其他产生命令
的路径，不能静默混入部分隔离的 Workspace，也不能回退到宿主。只有明确处于档案关闭
状态时，才能根据部署策略选择现有的可信路径。

本提案不启用 Kubernetes、static/remote provisioner、公开 CLI `serve` 或 ACP 策略接入，不覆盖 macOS、Windows、Landlock、任意配置加载、容量限流或空闲回收，也不修改生产安全默认值。公开 `serve` 继续受现有 selected-runtime 与 delegation 门禁约束。

## 拟议启用与资格验证

部署侧在 Managed runtime-broker 配置中提供带版本的隔离档案。具体属性名留给实现 PR；其值必须区分 `disabled` 与例如 `linux-bwrap-v1` 的档案，且不能从 `isolationClass=session` 或客户端请求推导。`disabled` 仍是默认值，本提案不修改任何生产配置以启用它。

只有 Linux 上的 `provisioner=local-process` 才接受 `linux-bwrap-v1`。选定的 Runtime 在资格回执中记录档案版本、策略 digest、binding ID、generation、Runtime instance 和 epoch。每次工具调用都检查相同的选定身份与不可变策略；进程全局标志或 primary Runtime 不能替代它。

资格验证必须在第一个用户 payload 之前，对选定 Runtime 做正向能力检查。它实际运行打包的 bwrap relay，证明所需的挂载、PID/网络 namespace、完成回执和父进程死亡行为；如果档案包含进程清理，还必须具备委派的 cgroup root 和 #14667 的空证明路径。缺少 bwrap、namespace 不可用、根目录变化、委派缺失、回执过期或结果未知时，Runtime 保持未获资格。Broker 在 payload 执行前返回 `confinement_unavailable`，绝不回退到宿主执行。

私有 root 挂载清单仍是开放的设计工作。只有在真实资格证据验证了某个 Linux 发行版的
interpreter 及其运行库、CA/NSS 数据、locale、临时目录和 Workspace 路径后，该发行版
才支持启用此档案。在完成对应清单验证前，档案在该发行版上必须保持拒绝或关闭；挂载
发现不能静默扩大 root。

## 文件系统与工具边界

实现复用 `executeBwrap`、现有 Runtime Shell 策略、受约束的 file worker、规范路径检查和完成回执。应增加 Managed 档案，不能把当前允许广泛读取的策略等同于完整隔离。

该档案建立私有文件系统视图：规范 Workspace 以已准入的读写模式挂载，只显式挂载所需的 interpreter、relay、worker、Runtime 状态和系统资源。其他 Workspace 根目录、宿主凭据、任意父目录和宿主可写路径都不可见、不可写。仅使用 `--ro-bind / /` 加写入限制是不够的，因为它仍允许广泛读取宿主文件。

保留现有安全措施：cwd 必须位于规范 Workspace 内；可写授权不能与 installation 或 state 重叠；scratch 和 control 目录私有；relay 环境移除内部 secret；bwrap 完成证据通过专用 status channel 验证。Shell 使用字面量 executable/argv，文件写入使用受约束 worker。Hooks、MCP 和其他产生命令的路径在接入同一边界前保持禁用。

## 进程生命周期与 #14667 交接

`--die-with-parent` 和 bwrap PID namespace 属于纵深防御，不是 Broker 的 stopped-worker 证明。选定 Runtime 在启动受约束进程前，于委派的 Managed root 下创建持久 cgroup 单元。单元身份随 Runtime drain receipt 传递，或写入以 binding ID 和 generation 为键的持久记录，并带上 Runtime instance/epoch。worker 死亡后 Broker 仍必须能够重新打开该单元。

关闭流程 drain 选定 Runtime，使用现有 cgroup supervisor 语义（最终升级使用 `cgroup.kill`），并取得 Broker 可见的 `empty()` 证明。`setsid`、双重 fork 和孤儿后代在证明为真前都保持被约束。单元缺失、无法重新打开或仍非空时，保留 storage holder，返回 `confinement_stop_unconfirmed`；Broker 不能把 worker PID 消失当成解锁。root 和 receipt 形状应与 #14667、#14502 协同，在适用处复用 `HookCommandCgroup`。本提案不声称该契约当前已经存在。

## 失败与兼容行为

- `confinement_unavailable`：选定 Runtime 无法证明请求的 Linux/bwrap/cgroup 档案。
- `confinement_denied`：路径、写入、网络操作或工具路径违反已准入策略。
- `confinement_stop_unconfirmed`：关闭时无法证明进程单元为空，因此所有权和恢复继续保持围栏。

工具结果说明是策略阻止了动作，并提供面向运维的处理建议，不泄露凭据，也不要求模型在边界外重试。结果不确定的执行绝不在宿主上重放。未启用 opt-in 时，当前可信 local-process 行为与兼容性保持不变。启用后，平台或 provisioner 不支持、能力缺失、策略不匹配和 Runtime 状态未知，都必须在 payload 执行前失败关闭。本提案不新增 schema、迁移、默认值或自动启用；任何持久化 receipt 字段都属于协调后的 #14667 实现。

## 验证与验收

实现 PR 必须在真实 Linux 上验证精确的选定 Runtime，不能只依赖 mock 或数字 PID。必须证明：默认情况下 opt-in 关闭；私有 root 资格和回执完整；两个互不相交的租户根不能跨根读取、写入、经符号链接穿越或修改 cwd；宿主写入被拒绝；每个准入文件/Shell 路径使用策略；不支持的路径在 setup 前拒绝；bwrap/setup/namespace/receipt 失败时不发送 payload，也不回退到宿主重试。

还要结合 #14667 覆盖 worker 死亡、`setsid`、双重 fork、cgroup 升级、单元重新打开、空证明、holder 保留和恢复；只有证明完成后才能 release。报告记录 Linux 发行版、内核、bwrap 版本、cgroup delegation、选定 Runtime 身份及精确产物。macOS 和 Windows 对此档案明确不支持。

当 `linux-bwrap-v1` 成为部署侧拥有的 `local-process` opt-in，私有挂载布局能够阻止跨 Workspace 读写，能力缺失或未知时失败关闭，#14667 证明成为关闭/恢复的一部分，拒绝有类型且可见，并且具备 exact-head Linux 证据时，维护者可以批准实现。本文件本身不是生产就绪信号。

## 待定决策与后续工作

- 为每个受支持的 Linux 发行版确定并验证私有 root 挂载清单，包括 interpreter library、证书、locale、临时文件和 Runtime 状态；完成验证前不得在该发行版启用档案。
- 确定 local-process、Hook 和 MCP lane 共享的委派 cgroup root 的所有者与稳定命名。
- 定义三个拒绝类型的协议形状，避免泄露宿主路径或触发模型重试。
- 决定后续档案是否需要显式批准的网络访问，以及不支持平台如何报告拒绝。

实现应拆成 #14667 进程证明契约、Linux Managed bwrap 档案、选定 Runtime delegation 以及真实 Linux 验收证据。在这些工作完成前，#15081 仍是设计提案，Managed local-process 默认仍是可信部署行为。
