# 收尾孤立的后台 shell 状态文件

[English](2026-11-07-orphaned-shell-status.md) | [简体中文](2026-11-07-orphaned-shell-status.zh-CN.md)

- 状态：提议（持久化取值需维护者认可）
- 日期：2026-11-07
- Issue：#15800
- 范围：`packages/core/src/services/backgroundShellRegistry.ts`、
  `packages/core/src/config/config.ts`，以及 `packages/core/src/tools/shell.ts` 中的状态文件
  引导文字

## 问题陈述

后台 shell（`run_shell_command` 且 `is_background: true`）在输出文件旁有一个 JSON 状态
文件。只有启动该 shell 的 CLI 进程会通过 `BackgroundShellRegistry.writeStatusFile()` 写它。
子进程以分离方式启动，因此会比被杀或崩溃的 CLI 活得更久。此后再没有任何东西把状态文件从
`running` 改走：恢复的会话按 shell 工具的引导去读该文件，会把早已结束的命令看成仍在运行。

## 现状

- 写入方：`register()`、`complete()`、`fail()` 和 `settleAsCancelled()`，以及有序关闭时的
  `abortAll()`。
- `writeStatusFile()` 记录了子进程 `pid`，以便被强杀的 CLI 留下的 `running` 状态文件“仍可
  交叉核对”，但没有代码执行这项核对。
- 引导文字列出的取值是 `running|completed|failed|cancelled`。
- 在 headless 模式下处理 SIGHUP（#15823）能缩小窗口，但写入侧的改动无法覆盖 SIGKILL、
  崩溃或断电。

## 目标

- 进程已不存在、且持有者已无法再更新的状态文件，不再显示 `running`。
- 绝不编造未被观察到的结果。
- 绝不改动仍可能由存活进程更新的状态文件。

## 非目标

- 事后补记结果，或重新接管仍存活的子进程。
- 执行环境中的 shell，其 pid 可能不在本机上。

## 提议的改动

### A. 收尾函数

`settleOrphanedShellStatusFiles(dir)` 读取会话 `background-shells` 目录中的每个 `*.status`
文件，打开时不跟随符号链接。若状态文件的 `status` 为 `running`，且记录的 `pid` 是正整数、
`isPidAlive` 判定其已不存在，就把它改写为 `status: 'unknown'` 并更新 `updatedAt`，其余字段
全部保留。写入使用与 `writeStatusFile()` 相同的原子、仅所有者可读写、不跟随链接的选项。

保持不动的情况：其他状态、没有 pid 的状态文件、无法读取或格式错误的文件，以及 pid 仍存活的
状态文件。

### B. 执行时机

`Config` 在接管一个会话时收尾当前会话的目录：

- 在 `initializeOnce` 中、会话写入器激活之后，覆盖在已恢复会话上启动的进程（`--continue`、
  `--resume`、守护进程恢复）；
- 在 `startNewSession` 切换到另一个会话 id 时，覆盖运行中 CLI 内的 `/resume`。

在这两个时点，该 Config 尚未跟踪该会话的任何 shell；而 `BackgroundShellRegistry.reset()`
只能在被切出会话没有运行中的托管 shell 时调用。恢复当前正在使用的会话不算切换，不做收尾。
新会话没有该目录，调用不产生任何效果。带有执行环境的 Config 会跳过。

### C. 引导文字

模型引导文字列出 `unknown`，并说明其含义：启动该进程的会话结束时没有记录进程是如何结束的。

## 关键设计决策

- **用 `unknown` 而不是 `failed`。** `failed` 会声称一个无人观察到的结果，而命令可能已经成功。
  这正是在 issue 中提出的待决问题；如果维护者更倾向 `failed` 加说明性的 `error`，只需改一行。
- **用子进程 pid，而不是持有者 pid。** 状态文件只记录子进程。收尾发生在该 Config 刚接管会话
  之时，因此之前的持有者不会再更新它；仍存活的子进程保持 `running`，这是真实状态。
- **pid 复用。** 被复用的 pid 看起来仍存活，状态文件保持 `running`，即今天的行为。该检查绝不
  会把存活进程改成 `unknown`。

## 约束与风险

- 不获取会话租约的写入方（TUI 和 headless CLI）理论上可能同时运行在同一会话上。如果其中一个
  恰好在子进程退出、而持有者尚未记录结果的瞬间收尾，持有者随后的写入仍会落盘；但若写入顺序
  相反，结果会停在 `unknown`。同一会话上两个并发写入方本身就不受支持。
- 旧版本写入的状态文件结构相同，按同样方式收尾。

## 验证计划

- 收尾函数的单元测试：pid 已不存在、pid 存活、其他状态、没有 pid、JSON 格式错误、非状态
  文件、目录不存在，以及通过默认 `isPidAlive` 检查一个真实已退出的进程。
- `Config` 测试：初始化时收尾其启动所在的会话；切换时收尾新会话；恢复当前会话时不收尾。
- 在 Ubuntu 24.04 与 Node 22 上：用仓库的模拟 OpenAI 服务驱动打包后的 CLI，在后台 shell
  运行期间分别以 SIGKILL 和向进程组发送 SIGHUP 结束 CLI，等命令跑完后恢复会话并读取状态
  文件。

## 验收标准

- 持有者 CLI 被杀、其后台命令结束后，恢复会话会把状态文件改为 `unknown`，并保留原有字段。
- 进程仍在运行的状态文件保持 `running`。
- 有序关闭仍像以前一样写入 `cancelled`。

## 待决问题

- 使用 `unknown`，还是 issue 中提到的 `failed` 加 `error`。
