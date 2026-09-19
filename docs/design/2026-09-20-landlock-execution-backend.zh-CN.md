# Landlock 工具执行后端

[English](2026-09-20-landlock-execution-backend.md) | [简体中文](2026-09-20-landlock-execution-backend.zh-CN.md)

## 状态与范围

本设计在 bwrap 交付建立的工具执行边界中加入 Landlock 文件系统后端。它堆叠在公开 bwrap CLI 切换之上，不恢复整 CLI 沙箱。Shell 命令、终端 Shell 入口和现有文件 worker 仍按每次工具调用进入隔离，CLI、模型传输、认证和会话状态继续运行在宿主机上。

首个 Landlock 版本用于 Linux 主机上 bwrap 缺失或不可用时的回退。它约束路径内容和目录结构变更，但 Linux Landlock 目前仍不能限制 `chmod`、`chown`、扩展属性或时间戳等所有元数据操作，也不提供 bwrap 的 PID 或网络 namespace。因此该后端报告 `partial` 文件系统执行完整性，要求 Landlock ABI 3 或更高版本以覆盖跨目录重命名和截断，并且只支持 `network: open`。它不会宣称部分执行的 Landlock profile 与 bwrap 等价。

## 操作员契约

`tools.executionSandbox.backend` 接受 `auto`、`bwrap` 或 `landlock`。

- `bwrap` 只探测和使用 bwrap，失败时停止启动。
- `landlock` 只探测和使用随包发布的 Landlock helper；`network: closed` 会在任何 payload 启动前被拒绝。
- `auto` 首先探测 bwrap。如果 bwrap 不可用且请求策略为 `network: open`，则探测 Landlock，并在内核可执行时选择它。对于 `network: closed`，bwrap 是唯一兼容候选；失败信息会说明 Landlock 无法满足网络策略。

后端选择在 runtime 初始化期间只执行一次。解析后的后端、执行完整性和 Landlock ABI 会冻结到活动 Config 策略中。命令执行阶段的设置失败不会再切换到另一个后端，也不会在宿主机上重放 payload。

检查命令和 UI 会同时展示请求后端与实际后端。Landlock 会显示 `partial` 和已探测的 ABI。文档明确列出未覆盖的元数据及进程/IPC 边界。因为 `auto` 可能在用户 namespace 或 mount 不可用的主机上从完整的 bwrap 执行切换到部分 Landlock 执行，这种可见性是必要条件。

## 随包 helper

Qwen Code 在 `packages/core/vendor/landlock-run/<arch>-linux/` 中为 Linux x64 和 arm64 发布 `qwen-landlock-run`。Apache-2.0 的 C11 源码直接使用稳定的 Landlock 原始 UAPI；发布二进制使用 musl 静态链接，因此没有运行时库依赖。

命令契约为：

```text
qwen-landlock-run --probe
qwen-landlock-run [--status-fd <fd>] [--ro <path>]... [--rw <path>]... -- <argv>...
```

`--ro` 授予读取和执行权限；`--rw` 授予协商 ABI 能处理的全部文件系统权限。已处理权限在这些根目录之外默认拒绝。文件 grant 会去除仅适用于目录的权限。任何缺失或无法打开的 grant、不支持的 ABI、ruleset 错误或 exec 失败都会以 125 退出，并输出带 `qwen-landlock-run: ` 前缀的诊断；helper 不会静默移除请求的 grant。

helper 要求 ABI 3。ABI 1 无法授予跨目录重新挂接，ABI 2 无法控制截断；接受这些内核会使常见内容写入路径脱离声明的策略。ABI 5 提供的设备 ioctl 权限会在可用时启用。更新内核新增的权限不会被当作完整覆盖；在产品契约和 helper 一起复核前，该后端始终保持 partial。

helper 设置 `PR_SET_NO_NEW_PRIVS`、安装 ruleset、设置父进程退出信号，然后 `exec` payload。Landlock 限制会跨 exec 保留并由后代继承。helper 通过专用状态文件描述符发送小型执行回执；不受限的 relay 将该回执和子进程状态转换为 bwrap 使用的同一种 confirmed/unconfirmed 回执，从而保留禁止盲目重试及诊断临时目录保留行为。

## 文件系统 profile

两个后端都保留广泛的宿主读取能力。Landlock 对 `/` 以下授予读取和执行权限，对 `/dev/null` 与每条命令的私有 scratch 目录授予写权限；仅在 `workspace-write` 下对规范化 workspace 授予写权限。runtime 状态和安装目录保持只读。helper 使用 `O_PATH` 打开规则根目录，因此规则绑定到文件系统对象，而不是信任后续文本路径查找。

Landlock 进程接收与 bwrap 相同的净化 payload 环境，其中 `TMPDIR`、`TMP` 和 `TEMP` 指向私有 scratch。现有 workspace/受保护根目录准入检查继续作为权威。文件写入仍通过同一个 worker 和版本检查；Shell 与文件路径通过 runtime 已解析的后端分发。

Landlock 不创建 PID namespace。宿主进程仍可见，而 Landlock 的 domain 比较会限制对权限更宽进程的 ptrace 类访问。首个 helper profile 不包含路径名或抽象 Unix socket 限制。因此 `network: open` 保留宿主网络和可达的宿主服务。在单独评审的 seccomp 或 namespace 设计能够覆盖完整网络语义之前，关闭网络仍是仅 bwrap 提供的承诺。

## 打包与验证

构建脚本使用原生 `musl-gcc` 或显式 Zig musl target，每次编译一个架构。两个提交的二进制由现有 core `vendor/` 包和 bundle 路径复制。专用 Linux x64/arm64 workflow 会重新构建 helper，与提交二进制逐字节比较，运行功能探测，并检查只读拒绝、workspace 写入允许、外部写入拒绝、后代继承及 launcher 失败归因。

单元测试覆盖设置校验、精确后端选择顺序、不兼容网络拒绝、probe 解析、资源解析、helper argv、后端分发、状态 wire 解析、诊断以及公开 `qwen sandbox` 的验证差异。真实 Linux 验收必须在两个架构上运行精确提交的 helper。macOS 测试可以验证选择与 argv 构造，但不能证明内核执行。

## 安全与兼容性

- 选择流程 fail-closed。probe 失败或启动失败都不会产生非隔离重试。
- `partial` 是执行事实，不能被调用方重新解释为 full 的普通警告。它覆盖 Landlock 文档明确的元数据操作缺口和缺少 namespace 隔离。
- 最低要求 ABI 3。未启用 Landlock 或 ABI 更旧的内核不可用。
- 网络关闭策略绝不选择 Landlock。
- 在进入隔离前已打开的文件描述符保留原有权限。launcher 仅继承命令标准流和执行状态描述符。
- 如果 relay 退出，helper 的父进程退出信号会终止直接 payload。Landlock 不提供 PID namespace 生命周期边界：脱离的后代继续继承文件系统限制，但其清理由现有 runtime 进程清理机制负责，而不具备 `--die-with-parent` 语义。
- 宿主读取、进程可见性和宿主 Unix socket 可达性不属于首个 Landlock 承诺，并会在文档和验证输出中展示。

## 后续工作

未来可用 seccomp 伴随层在没有 bwrap 时提供关闭网络，但它需要独立的 syscall 与兼容性设计。Landlock 较新的 IPC scope、ABI 9 路径名 Unix socket 解析及未来文件系统权限，只能在精确内核测试及明确执行完整性决策后采用。本 PR 不改变 ACP/serve 支持，不扩大可写根目录，不加入由每次审批派生的策略，也不改变整 CLI Docker/Podman/Seatbelt 路径。
