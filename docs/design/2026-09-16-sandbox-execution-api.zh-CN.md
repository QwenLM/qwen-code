# 沙箱执行 API

[English](2026-09-16-sandbox-execution-api.md) | [简体中文](2026-09-16-sandbox-execution-api.zh-CN.md)

## 状态与问题

这是已验证的 bwrap 原型之后，[工具执行沙箱](2026-09-16-tool-execution-sandbox.zh-CN.md)的接口实现阶段。原型通过宿主 shell 转发 argv，并使用独立进程 API 写文件，都不是预期的 core 接口。本阶段增加内部 API 和随包安装的 worker；现有 CLI 工具和配置仍使用当前路径。

后续的 [runtime Shell 接入](2026-09-16-runtime-shell-sandbox.zh-CN.md)将这些 API 接入受限的可信宿主 headless runtime，并增加终结错误映射。下方结果描述 API 阶段的 v4 快照，不代表后续实现的当前字节。

后续 [runtime 文件工具阶段](2026-09-16-runtime-file-sandbox.zh-CN.md)将有限 JSON worker 替换为二进制正文、stat 版本检查和共享原子写入器，以保留文件语义。下文 1 MiB 协议及文件限制属于 API 阶段快照。

## 设计

`ShellExecutionService.executeLaunch` 接收绝对可执行路径、argv、绝对 cwd、精确环境变量，以及可选的、由调用方限制大小的 stdin 字节。异步初始化前复制启动输入。复用现有 pipe/PTY 的输出、取消和后台生命周期，不经过 shell 解析，不隐式增加环境变量。stdin 请求仅支持 pipe，以 EOF 结束。PTY 启动必须显式提供非空 `TERM`；POSIX PTY 还必须提供与 cwd 相等的 `PWD`。适配器保留这些显式值，避免 node-pty 自动添加或覆盖。PTY 仅在进程尚未创建时允许回退，且保留相同启动参数。沙箱或后端失败不会重放命令。

Linux bwrap 适配器接收可信的工作区、安装目录和运行状态目录，以及 read-only/workspace-write 文件系统策略和 open/closed 网络策略。规范化路径后拒绝可写目录与受保护状态、安装和系统路径重叠。每次执行创建独立 scratch 目录，并在运行状态目录下创建控制目录。沙箱使用只读根目录、独立 PID namespace、全新 `/proc`、最小 `/dev`、显式环境变量和可选的网络 namespace。这是首个内部适配器，不包含完整的用户路径策略准入或后端自动选择。

直接启动固定安装的 Node relay，使用独立于 payload 环境的最小启动环境。适配器剔除 payload 环境中的 Qwen 内部秘密，并将 `TMPDIR`、`TMP` 和 `TEMP` 指向独立 scratch，将 `PWD` 设为规范化的 cwd。relay 继承 pipe 或 PTY stdio，并启动 bwrap，通过独立 FD 3 接收 `--json-status-fd`。沙箱子进程会关闭该 FD。relay 使用排他创建、不跟随符号链接及 `0600` 权限建立普通状态文件；其描述符不传给 bwrap。整个控制目录对 payload 在内核层只读，且与可写根目录不重叠。不能用 Unix socket 替代，因为只读挂载不能阻止连接 socket。relay 在启动前和之后每 100 ms 检查预期父 PID；父进程消失后 relay 退出，由 bwrap `--die-with-parent` 终止 namespace。这是有周期的轮询，不是 relay 上即时生效的原生父进程死亡信号。

有大小限制的状态流独立于 stdout/stderr 解析。bwrap 最终的 `exit-code` 确认 payload 成功 exec 及其退出状态。初始 `child-pid` 不是设置完成事件。缺失、格式错误或截断的最终证据均为 `unconfirmed`，包括 payload 执行后的 supervisor 错误。取消或信号终止为 `interrupted`；转入后台为 `running`，直到独立的 settlement promise 完成。这些状态都不允许自动重试。scratch/控制目录保留到后台进程最终结束后才清理。清理错误记录日志，不丢失执行结果。若传输错误导致无法确认进程终止，保留目录供后续检查，避免删除仍在使用的资源。宿主崩溃可能遗留临时目录；恢复和垃圾回收留待后续实现。

随包安装的文件 worker 通过 stdin 接收最多 1 MiB 的 UTF-8 JSON。它验证写入请求、检查预期内容、在同目录建立临时文件、再次检查内容并在沙箱内 rename。客户端使用同一个 bwrap 适配器，同时检查可信执行状态和 worker 回复。内核约束符号链接穿透和写入。这个有限 worker 不提供并发写入时的原子 compare-and-swap，不保留已有文件权限，也不支持二进制编辑；迁移生产文件工具前需要解决这些语义。

## 文件与范围

修改 core shell 服务及测试、`packages/core/src/sandbox/`、独立 relay/file-worker 构建入口、打包资源清单及 Linux 原型验证器。现有 `execute` 调用方保留命令字符串接口。不包含 Landlock helper、新配置、权限流程、前端工具迁移、macOS/Windows 沙箱后端、Bun 独立包支持或读取保密性。可信的同用户宿主进程，以及沙箱外攻击者修改工作区祖先路径，不在首个适配器的威胁模型内。已有硬链接别名仍有统一设计中记录的限制；此适配器不承诺 inode 级整体不可变。

## 验证与验收

定向单测证明 argv 字面传递、精确环境变量、不可变启动快照、stdin EOF/提前关闭处理、stdin 仅限 pipe，以及 PTY 创建后不重放。真实 Linux 测试覆盖 pipe 和实际 PTY、namespace、写入拒绝、网络模式、取消、后台最终结束、父进程死亡及 worker 输入。状态测试区分 payload 非零退出、未确认的设置失败以及执行后的中断；伪造 stdout、写状态 FD 和控制文件不能伪造凭据。打包资源必须存在。build、typecheck、bundle 必须通过；全局 CLI 和本地 CLI 版本冒烟检查明确这是内部 API 阶段，不是新增用户开关。

## 验证结果（2026-09-16）

最终 v4 实现通过 178 项定向单测、31 项真实 Linux 套件检查及 6 项独立对抗检查。Linux 证据来自 Lima `qwen-sbx`、ARM64、Linux `7.0.0-31-generic`、Node `v22.22.1`、bwrap `0.11.1` 和真实 `@lydell/node-pty@1.2.0-beta.10`。独立检查确认 PTY 环境值显式传递、Qwen 秘密剔除、后台晋升期间 scratch 保留、最终清理，以及执行后回执丢失时的保守处理。此前独立探针发现隐式 `PWD` 注入；最终契约和负例测试已解决此差异。

仓库构建、最新 core 重建、typecheck、bundle、定向 lint 和格式检查均通过。本地 bundle CLI 返回 `0.23.4`。npm 打包预检包含两个 worker，字节与 Linux 验证产物一致。独立代码审查未发现本阶段剩余阻塞项。v4 manifest 中 275 个输入 hash 与该阶段完成时的源码匹配；shell bundle SHA-256 为 `410260db7ce72eeaa3c5ffcb050ddd91901b2f131abda798f8a3c2aa4b1aa4cc`。测试安装、fixture 和归属于测试的进程均已清理。详细基线、中间失败探针和最终日志记录于 `.qwen/e2e-tests/sandbox-execution-api.md`。这些是内部执行链路集成检查，不是完整模型 E2E 或生产功能启用。Linux x64、其他内核、完整文件语义和 Landlock 留待后续。

## 待解决问题

实时可信 exec 就绪事件需要另一个可信的内部 exec helper；bwrap 0.11.1 仅提供最终 exec 证据。完整路径准入、崩溃清理、文件权限/二进制/并发语义和工具迁移仍是独立里程碑。Landlock 后续必须满足同一个执行接口，不能削弱策略。
