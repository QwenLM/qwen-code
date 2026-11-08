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
  交叉核对”，但没有代码执行这项核对。单凭 pid 无法知道它在哪里指向进程：宿主与容器、或两台
  机器，可能共享同一个 `~/.qwen` 和项目路径。
- 引导文字列出的取值是 `running|completed|failed|cancelled`。
- 在 headless 模式下处理 SIGHUP（#15823）能缩小窗口，但写入侧的改动无法覆盖 SIGKILL、
  崩溃或断电。

## 目标

- 进程已不存在、且持有者已无法再更新的状态文件，不再显示 `running`。
- 绝不编造未被观察到的结果。
- 绝不改动仍可能由存活进程更新的状态文件。
- 绝不在记录 pid 的范围之外判断该 pid。

## 非目标

- 事后补记结果，或重新接管仍存活的子进程。
- 执行环境中的 shell，其 pid 可能不在本机上。

## 提议的改动

### A. pid 范围

`writeStatusFile()` 在 `pid` 旁边记录它所属的范围：

```json
"pidScope": { "hostname": "…", "bootId": "…", "pidNamespace": 4026531836 }
```

`hostname` 取自 `os.hostname()`；`bootId` 与 `pidNamespace` 来自 `process-liveness.ts` 中已有的
`readLocalBootId()` 和 `readPidNamespaceId()`，平台不提供时为 `null`。仅凭主机名无法区分机器。
只有开机 ID 和 pid 命名空间身份都可用，且三项都与执行收尾的进程一致时，状态文件才会被收尾。
两个 `null` 相等不能证明范围相同。缺少这些身份时（包括 macOS 和 Windows），跳过自动收尾，
状态文件保持 `running`。

### B. 收尾函数

`settleOrphanedShellStatusFiles(dir)` 读取会话 `background-shells` 目录中的每个 `*.status`
文件。打开时使用 `openSyncNoFollow(path, { nonBlocking: true })`，既不跟随符号链接，也不会在
FIFO 上等待；只有 `fstat` 报告为不超过 1 MiB 的普通文件才会被读取。读取缓冲区为该大小加一个
字节，因此检查大小后又增长的文件会被发现并保持不动；`writeStatusFile()` 是整体替换状态文件，
不会追加。短读取会继续到 EOF 或该上限。若
状态文件的 `status` 为 `running`，记录的 `pid` 是正的安全整数，`pidScope` 一致，且
`isPidAlive` 判定其进程已不存在，就把它改写为 `status: 'unknown'` 并更新 `updatedAt`，其余
字段全部保留。写入使用与 `writeStatusFile()` 相同的原子、仅所有者可读写、不跟随链接的选项。
持久化取值有自己的类型 `ShellStatusFileStatus`；`BackgroundShellStatus` 仍是内存中的取值集合。

保持不动的情况：其他状态、没有 pid 或 pid 无效的状态文件、`pidScope` 不同、缺失或缺少开机 ID
或 pid 命名空间身份的状态文件、非普通文件、过大、无法读取或格式错误的文件，以及 pid 仍存活的
状态文件。某个状态文件出错不会
影响其他文件。

函数返回仍为 `running`、之后可能需要收尾的状态文件：进程仍存活的、改写失败的，以及无法读取的
（此时还没有 pid）。`watchOrphanedShellStatusFiles(orphans)` 每两秒检查它们。每次尝试都会重新
读取状态文件，并在写入前核对范围和进程，因此先前读到的 pid 只在该进程存活期间省去一次读取。
进程一结束就用同样方式收尾，并一直监视到收尾成功或不再需要收尾，因此读写失败会被重试，且只
记录一次日志。其定时器不会阻止进程
退出，并返回一个用于停止监视的函数。

### C. 执行时机

`Config` 在接管一个会话时收尾当前会话的目录：

- 在 `initializeOnce` 中、会话写入器激活之后，覆盖在已恢复会话上启动的进程（`--continue`、
  `--resume`、守护进程恢复）；
- 在 `startNewSession` 切换到另一个会话 id 时，覆盖运行中 CLI 内的 `/resume`。

如果此时状态文件仍为 `running`，Config 会继续监视，因此恢复之后才结束的命令也会在同一会话内被
收尾。切换到其他会话或关闭时停止监视。

在这两个时点，该 Config 尚未跟踪该会话的任何 shell；而 `BackgroundShellRegistry.reset()`
只能在被切出会话没有运行中的托管 shell 时调用。恢复当前正在使用的会话不算切换，不做收尾。
新会话没有该目录，调用不产生任何效果。带有执行环境的 Config 会跳过。

### D. 引导文字

模型引导文字列出 `unknown`，并说明其含义：启动该进程的会话结束时没有记录进程是如何结束的。
引导文字还说明，`running` 可能比写入它的会话存活得更久：如果该会话没有正常关闭，应先核对记录的
pid 是否仍存活，再认定进程仍在运行。这覆盖了范围核对保持为 `running` 的状态文件，即 macOS 和
Windows 上的，以及旧版本写入的。

## 关键设计决策

- **用 `unknown` 而不是 `failed`。** `failed` 会声称一个无人观察到的结果，而命令可能已经成功。
  这正是在 issue 中提出的待决问题；如果维护者更倾向 `failed` 加说明性的 `error`，只需改一行。
- **用子进程 pid，而不是持有者 pid。** 状态文件只记录子进程。收尾发生在该 Config 刚接管会话
  之时，因此之前的持有者不会再更新它；仍存活的子进程保持 `running`，这是真实状态。
- **先核对范围，再判断存活。** 来自其他 pid 命名空间、机器或开机周期的 pid，在本机可能查不到，
  而其进程仍在运行；此时引导文字会让模型以为仍在运行的命令已经结束。范围核对让这类状态文件保持
  `running`，即今天的行为。`packages/sdk-typescript/src/peer/registry.ts` 中的对等注册表遵循同样的保守
  规则。
- **没有范围的状态文件保持 `running`。** 旧版本不写 `pidScope`，无法判断其 pid 是否属于本机，
  因此保持今天的行为。状态文件按会话存放，只影响升级前启动的会话。
- **pid 复用。** 同一范围内被复用的 pid 看起来仍存活，状态文件保持 `running`，即今天的行为。
  启动时间令牌可以让被复用的 pid 也得到收尾，但它只在 Linux 上可用，而避免误判为 `unknown`
  并不需要它。

## 约束与风险

- 不获取会话租约的写入方（TUI 和 headless CLI）理论上可能同时运行在同一会话上。如果其中一个
  恰好在子进程退出、而持有者尚未记录结果的瞬间收尾，持有者随后的写入仍会落盘；但若写入顺序
  相反，结果会停在 `unknown`。同一会话上两个并发写入方本身就不受支持。
- 旧版本写入的状态文件没有 `pidScope`，保持 `running`。
- 自动收尾目前依赖 Linux 的开机 ID 和 pid 命名空间身份。macOS、Windows，或无法读取任一身份
  的 Linux 上，状态文件保持 `running`；仅凭相同主机名不足以判断其中的 pid。
- 主机名变化（macOS 在网络变化时可能发生）会让该会话的状态文件保持 `running`。在之前的沙箱
  容器中写入的状态文件也会保留，因为新容器的 pid 命名空间不同，看不到旧容器的进程。

## 验证计划

- 收尾函数的单元测试：pid 已不存在、pid 存活、pid 命名空间、开机 ID 或主机名不同、没有或不完整的范围、
  其他状态、没有 pid、无效 pid、JSON 格式错误、内容像状态文件的非状态文件、FIFO、过大的文件、
  检查大小后的文件增长、恰好达到上限和超过上限一个字节、跨多字节文本的短读取、某个状态文件
  检查时抛错、符号链接形式的状态文件、目录不存在、通过默认 `isPidAlive` 检查一个真实已退出的
  进程，以及注册表写入的状态文件：在 Linux 上以本机范围收尾，在无法证明范围的平台上保持
  `running`。
- 监视测试：被监视的状态文件在进程退出后收尾，停止监视后不再改动；改写失败会重试直到成功，同时
  其他状态文件照常收尾；接管时无法读取的状态文件会被监视，可读后收尾；定时器已 unref；并用真实子进程验证接管时仍存活、之后才退出的进程，在
  没有第二次接管的情况下也会被收尾。
- `Config` 测试：初始化时收尾其启动所在的会话；切换时收尾新会话；恢复当前会话时不收尾；仍为
  `running` 的状态文件会被监视，切换和关闭时停止；带执行环境的 Config 不收尾；收尾抛错不影响
  初始化。
- 引导文字测试：在启动和转入后台两种消息中断言 `unknown`、其含义，以及对陈旧 `running` 的核对说明。
- `openSyncNoFollow` 测试：设置 `nonBlocking` 后，原生路径和兼容路径打开 FIFO 都不会等待。
- 变异检查：逐一移除上述保护时，都会有测试失败。
- 在 Ubuntu 24.04 与 Node 22 上，以及 macOS 上：用仓库的模拟 OpenAI 服务驱动打包后的 CLI，
  在后台 shell 运行期间分别以 SIGKILL 和向进程组发送 SIGHUP 结束 CLI，等命令跑完后恢复会话并
  读取状态文件。再把状态文件的 `pidScope` 改为另一台主机重复一次，它必须保持 `running`。
  macOS 的本机范围缺少这些身份，应验证默认恢复会保留 `running`，不会只凭主机名判断 pid。

## 验收标准

- 范围身份已确认相同时，持有者 CLI 被杀、其后台命令结束后，恢复会话会把状态文件改为
  `unknown`，并保留原有字段。
- 范围身份已确认相同时，进程仍在运行的状态文件保持 `running`；在恢复的会话打开期间该进程
  退出后，变为 `unknown`。
- 在其他 pid 范围写入、没有范围，或缺少开机 ID 或 pid 命名空间身份的状态文件保持 `running`。
- 有序关闭仍像以前一样写入 `cancelled`。

## 待决问题

- 使用 `unknown`，还是 issue 中提到的 `failed` 加 `error`。
