# Hook 进程树取消

[English](hook-process-tree-cancellation.md) | [简体中文](hook-process-tree-cancellation.zh-CN.md)

## 问题

命令 hook 通过 shell 运行，可能产生嵌套进程。HookRunner 目前只向直接的 shell 进程发送信号，并依据 `ChildProcess.killed` 来决定是否从 SIGTERM 升级为 SIGKILL。该属性记录的是「信号已发出」，而不是「进程已退出」，因此一个无响应的 shell 可以阻止升级，其后代进程则可能作为孤儿进程存活下来。

## 设计

在 POSIX 上，HookRunner 以分离（detached）子进程方式启动每个命令 hook，使 shell 成为一个自有进程组的组长。正常完成路径不变。当 hook 超时或收到 AbortSignal 时，HookRunner 启动一次幂等的终止操作：

1. 向自有进程组发送 SIGTERM。
2. 轮询进程组是否存在，最长两秒。
3. 如果进程组仍然存在，向该组发送 SIGKILL。
4. 只有在终止动作到达上述终态之一后，才返回既有的超时或取消结果。

根子进程关闭不会取消升级，因为根进程退出后其组内仍可能留有后代。SIGKILL 被接受后，HookRunner 不等待进程 ID 消失：被终止的进程在新父进程回收（reap）之前，可能短暂地以僵尸状态保持可见。

在 POSIX 命令 hook 运行期间，HookRunner 会将其自有进程组注册到一个同步的进程退出兜底逻辑中。如果父进程在正常取消完成之前到达 Node 的 exit 事件，该兜底逻辑会向每个进程作用域的 hook 进程组发送 SIGKILL，而不是留下分离的进程树。临时的 SIGHUP、SIGINT、SIGQUIT 和 SIGTERM 处理器会在重新抛出未处理信号、或将父进程的优雅退出交还给应用处理器之前，回收这些进程组。

`MessageDisplay`、`StopFailure` 和 `SessionDelete` 的命令 hook 属于例外，因为这些事件以 fire-and-forget 方式派发，其输出不具有控制作用。Qwen 会同步地将它们的输入写入一个 0600 权限的临时文件，然后启动一个未被引用（unreferenced）、分离的 supervisor，其 stdin、stdout 和 stderr 均不依赖 Qwen。supervisor 打开该输入文件作为 hook 的 stdin，并在平台允许时在启动 hook 后删除其目录项，否则在 hook 完成时重试，从而在 Qwen 退出时不会丢失排队中的管道写入，敏感输入也不会被保留得比必要时间更长。内部的 Node supervisor 不继承用户的 `NODE_OPTIONS`；它单独传递原始值，并且只针对实际的 hook 命令恢复它。

supervisor 的优雅退出和受处理的终止信号会移除暂存输入并终止自有的 hook 进程组。在暂存输入与 supervisor 删除其目录项之间的短暂窗口内，一次无法捕获的 SIGKILL 可能留下该 0600 权限文件。hook 启动之后的一次无法捕获的 SIGKILL 也可能让独立拥有的 hook 进程组继续运行。弥合这些宿主机故障缺口需要外部回收器或单独的进程组身份通道，不在本次改动范围内。

在 POSIX 上，supervisor 在独立的自有进程组中启动命令，并在 Qwen 退出后保留既定的截止时间。根进程关闭会记录退出状态，但只要组内还有其他进程，就不算完成。正常完成会在进程组清空后立即结束 supervisor；超时则向进程组发送 TERM 然后是 KILL。在 Qwen 仍然存活时，AbortSignal 取消会终止 supervisor，由它将同样的进程树清理转发给命令进程组。通用的 `async: true` hook 仍属于进程作用域：其捕获的输出属于 AsyncHookRegistry，并且在 POSIX 上随 Qwen 进程退出时被回收。

Windows 不暴露 POSIX 进程组信号。HookRunner 改为异步调用 System32 下的绝对路径 `taskkill.exe`，参数为 `/f /t /pid`，并限定执行时间；当根子进程已经退出时跳过该调用。taskkill 失败会回退为强制杀死直接子进程，并发出诊断警告。

对于父进程退出后仍存活的 `MessageDisplay`、`StopFailure` 和 `SessionDelete` hook，supervisor 会通过 fd 3 上报 hook shell 的 pid，因此即使 supervisor 已经退出、其旧有进程树已无法重建，该 shell 仍能被回收。在 Qwen 存活期间，hook 终止会先通过共享的 `isPidAlive` 辅助函数探测该 pid，绝不会对已经退出的 pid 执行 taskkill；探测被拒绝（EPERM 或 EACCES）视为存活，而意外的探测错误视为已死。当 taskkill 失败或超时时，第二次探测会决定是否执行直接的 pid 级 SIGKILL 回退；被拒绝的回退会记录日志而不是被静默吞掉。两次探测共同构成 pid 复用防护：taskkill 没有进程组等价物，因此绝不能对一个可能已被回收并复用到无关应用上的 pid 发起。探测确立的是「存在」而非「身份」——Windows 没有廉价的进程启动令牌，因此在探测与杀死之间被复用的 pid 仍是一个残余风险，需要 Windows Job Object 才能弥合。

超时与 AbortSignal 竞争共享同一个终止 promise。Abort 保留其既有的结果优先级，hook 的正常成功、输出解析、退出码处理以及超时默认值均保持不变。

进程树终止之后，HookRunner 最长等待一秒让根子进程关闭，以便其 stdout 和 stderr 流排空。如果 close 事件始终未到达，它会销毁这些流并返回取消结果，使取消路径保持有界。

## 非目标

- 将 ACP 会话初始化截止时间传播到 SessionStart。
- 管理 ACP 子进程树。
- 回收通过守护化或新会话故意脱离自有进程组的进程。
- 为 POSIX 命令 hook 保留控制终端访问。创建自有进程组使用分离会话，因此不支持直接打开 `/dev/tty` 的命令。
- 在无法捕获的父进程 SIGKILL 或宿主机故障之后回收分离进程组，因为这些故障会阻止所有 JavaScript 退出处理逻辑运行。
- 更改扩展配置、hook 超时默认值或 AsyncHookRegistry 未使用的进程字段。

## 测试计划

- 单元测试进程组所有权、父进程无关的 supervisor 选择、TERM 到 KILL 的时序、根进程关闭竞争、超时/中止竞争、父进程退出兜底、正常完成、spawn 错误、Windows taskkill 回退，以及 Windows 存活 hook 回收（活性探测门控、探测被拒绝与探测出错处理、SIGKILL 回退，以及对已退出进程跳过杀死）。
- 运行一个 POSIX 进程测试：其后代确认收到 SIGTERM、忽略它，随后被进程组 SIGKILL 置为非运行状态。
- 运行 POSIX 进程测试，证明进程作用域的异步 hook 在父进程退出时被回收，而 `MessageDisplay`、`StopFailure` 和 `SessionDelete` hook 让 Qwen 自然退出且自身仍能在此之后完成。
- 运行 POSIX 进程测试，证明存活 hook 在 Qwen 退出后保留其超时时间、在根进程先于某个后代退出时仍保持监管、保留显式中止，并能完整接收大于 OS 管道缓冲区的输入。
