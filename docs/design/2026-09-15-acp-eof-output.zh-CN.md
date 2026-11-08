# ACP 在 EOF 退出前排空输出

[English](2026-09-15-acp-eof-output.md) | [简体中文](2026-09-15-acp-eof-output.zh-CN.md)

## 问题与证据

已安装的 0.23.3 ACP 进程可能在输入 EOF 后退出 0，却留下不完整的
`available_commands_update` 帧。受控客户端在帧开始后暂停读取 101 毫秒，随后
持续读取至 stdout 结束。实际 ACP 进程自然退出，留下 196,608 字节的未终止
片段，没有发送清理信号。测试使用安装内的 Node 和 CLI 绕过包装器，确保捕获
的是 ACP 自身退出。此前未等待完整 stdout 的脚本结果仅保留为历史观察。

SDK 在输入结束时完成 `connection.closed`，不等待私有写队列排空。CLI 清理后
调用 `process.exit`。Web writer 写入成功也不足以证明完成：Node 的
`Writable.toWeb` 在未触发背压时可以先于原生写回调完成。成功退出前需要等待
原生输出 finish。

## 决策与边界

在 `acp-output.ts` 为 `runAcpAgent` 提供私有输出所有者。它持有
`Writable.toWeb(process.stdout)` 的 writer，向 NDJSON 提供带准入检查的字节流。
普通写入直接返回底层写 promise。EOF 清理后同步停止接收新帧，再关闭底层
writer。原生 end/finish 排在带准入检查的流的 sink 已转交给内层 writer
`write()` 的帧之后；后续 sink 回调拒绝写入，不再进入 stdout。
关闭操作复用同一个 promise，保持幂等。

等待 writer 的 `closed` promise，保留原始写入/finish 错误，即使 errored
stream 的 `close()` 只报告状态错误。输出排空最多等待两秒，与普通单项清理
预算一致。超时则拒绝并直接销毁原生输出，不等待可能排在阻塞写入之后的 Web
abort。操作结束后释放定时器和 writer 锁。

报告 EOF 清理及输出错误，两者同时发生时聚合。排空失败的报告方式属于可观察
行为变化：Linux 评审中的基线 `a98711330c` 在永久停读时输出被截断却退出 0，
在读端关闭时记录 EPIPE 但仍退出 0；`cc0f7c6949` 则分别携带排空超时或原始
EPIPE 退出 1。这是失败报告的改善，不是保留基线退出码。通过关闭读管道断开的
IDE 或嵌入式客户端可能观察到新的退出码 1。
[Linux A/B 报告](https://github.com/QwenLM/qwen-code/pull/11916#issuecomment-5677832569)
记录了这些测量；本次文档修正没有重跑。

排空期间保留信号处理器。现有 SIGTERM/SIGINT 的 destroy-and-exit 路径继续
生效，不将其报告为正常排空。不修改会话 disposal、命令列表内容、SDK 队列、信号期限或
协议字段。

保证范围仅包含封口前已转交给内层 writer 的帧：完整写完，否则报告排空失败。
仍在 SDK、NDJSON 或带准入检查的 Web stream 中排队的调用尚未跨过这个边界，
即使调用方在 EOF 前已经发出。它们之后可能被 `ACP output is closed` 拒绝，
由 SDK 记录错误并丢弃，而 ACP 仍退出 0。
[沙箱报告](https://github.com/QwenLM/qwen-code/pull/11916#issuecomment-5691411334)
在 `b8124075c6` 测得该残余行为：200 帧积压仅交付 93 个完整帧（已发出的
431,090 字节中收到 200,405 字节，46.5%），退出 0；其基线没有交付字节，
也退出 0。这是单个测试脚本的观察，不是交付比例保证。上游队列排空继续延后。

本修复不承诺 EOF 后仍在执行的每个入站 RPC 都收到回复，不停止 SDK 内部队列，
也不能向永久停止读取的对端保证交付。它独立于 #11866 保持行为的重构。

## 验证

用真实 Node Writable 验证低于背压阈值的小帧、大帧待完成写入、finish 失败、
原始写错误、迟到帧、重复关闭及永久停读。验证 EOF 集成顺序、清理失败保留和
信号交错。独立测试工程师对最终 bundle 重跑公共客户端复现，等待真实 ACP
退出及 stdout end/close，再检查完整 NDJSON 和进程/端口清理。

执行受影响测试、build、typecheck、bundle、lint，随后进行两轮无问题自审及
独立审查。原始复现和其他失败观察保留在
`.qwen/issues/issue-11866-acp-eof-output.md`。

## 最终验证结果

实现通过七项真实 Writable 测试、受影响的 ACP/CLI 测试、build、typecheck、lint
和 bundle 检查。三组已有传输 mock 测试在同一边界 mock 私有输出所有者：
`acpAgent.test.ts`、`acpAgent.worktree.test.ts` 和 `plan-mode-config.test.ts`。
第一组已有该 mock 后，为后两组补齐了 mock；后两组的首次失败及调整后四项通过
结果均保留。两轮无问题自审和
独立审查未发现未决源码缺陷。

首轮最终组合 bundle 通过两种直接 ACP EOF 场景：收到首个帧片段后 EOF，以及收到
完整帧后 EOF。两个实际 ACP 进程均自然退出 0，收到完整的 1,058,795 字节命令
帧及全部 524,288 字节 fixture。仅归一化会话 UUID 和精确临时目录后，两帧
一致。全局基线的命令目录不同，因此不宣称与已安装 CLI 的完整命令目录一致。

永久停读导致实际 ACP 在 2,021 毫秒后退出 1，保留原始排空超时错误。关闭读管道
导致实际 ACP 在 16 毫秒后退出 1，保留原始 EPIPE。原始脚本失败作为预期负例
结果保留。正例等待 stdout end/close；EPIPE 场景观察预期的读端关闭。独立检查
未发现所拥有的进程、进程组或监听端口残留。八个组合 E2E 样本执行前后，包含
1,079 个文件的 bundle 清单保持一致。

恢复已安装的 Ink 补丁并重新构建后，八个场景再次满足相同验收条件。两个正常
EOF 进程均退出 0，输出 1,062,289 字节 stdout；使用同样的归一化后，与此前
最终产物的输出逐字节一致。停读场景在 2,024 毫秒后退出 1，保留原始超时；
关闭管道场景在 13 毫秒后退出 1，保留 EPIPE。新的 1,079 文件清单在验证前后
一致，没有所拥有的进程或监听端口残留。`post-install-e2e-manifest.json`
另行记录第二份产物的结果。

可复现的 EOF 截断已在所述输出所有者边界内验证修复。不追溯认定曾崩溃或未捕获
实际退出的历史观察脚本的原因或退出码。组合变更的仓库级验证记录在
[完成设计](2026-09-15-acp-bridge-completion.zh-CN.md)中。
