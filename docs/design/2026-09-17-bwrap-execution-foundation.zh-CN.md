# bwrap 执行底座

[English](2026-09-17-bwrap-execution-foundation.md) | [简体中文](2026-09-17-bwrap-execution-foundation.zh-CN.md)

## 状态与问题

这是此前集中在 PR #12064 中的工具执行沙箱工作的第一个独立实现部分，仅增加内部执行底座。Runtime 策略、工具路由、公开设置和旧整 CLI bwrap 后端的退役属于后续改动。现有 CLI 入口保持当前行为。

Shell 服务当前通过 shell 启动命令字符串。沙箱适配器需要字面量 executable/argv、精确环境、worker 的 stdin 传输，以及无需重建 shell 命令的同一套管道/PTY 生命周期。它还需要 payload 无法通过普通输出伪造的完成证据。

## 执行契约

`ShellExecutionService.executeLaunch` 接收绝对可执行文件路径、字面量 argv、绝对 cwd、精确环境，以及可选的 string/Buffer stdin。在异步初始化前复制调用者拥有的值。Stdin 仅支持管道，并在发送给定字节后关闭。PTY 调用者必须提供 `TERM`；POSIX PTY 调用者必须提供与 cwd 一致的 `PWD`。现有命令字符串 `execute` API 保留环境准备与 shell 解析。

两套 API 共享输出、取消、后台提升和终端管理。管道流式输出按 chunk 区分 stdout/stderr；子进程退出后末尾输出继续流动，结算发生在流关闭或退出后有界排空（1 秒）二者先到之时，持有管道的孙进程无法卡死结算。逐 chunk 的 `stream` 标记是为下一切片预留的管线：daemon UI 协议已建模该字段，本切片内 core 没有消费者读取它。仅在尚未创建进程时允许从 PTY 回退到管道；spawn 后的失败不得重放 payload。输入字节由调用者负责，启动 API 不另加任意大小上限。传输层 stdin 失败仅在进程没有留下任何退出信息时作为执行错误上报；否则以进程自身的退出状态为准。

## Linux 适配器与可信完成证据

`executeBwrap` 接收可信工作区、安装和 runtime 状态目录，以及 read-only/workspace-write 文件系统策略与 open/closed 网络策略。它规范化路径，拒绝与 HOME 及其祖先、安装/状态目录、worker/runtime 二进制、配置的保护根或受保护系统路径重叠的写入授权。Cwd 必须位于工作区内。每次执行拥有私有 scratch 和独立宿主控制目录。

适配器将宿主根目录挂为只读，按策略开放工作区写入，挂载私有 scratch，创建带新 procfs 和最小设备集的独立 PID namespace，并按策略创建独立网络 namespace。它从显式提供的 payload 环境移除 Qwen 内部秘密变量，并设置规范化 `PWD` 和私有临时路径。可信安装目录中的 Node relay 使用与 payload 环境分离的最小引导环境启动。

Relay 读取 payload 不继承的 bwrap 专用状态 FD，将有大小限制的结果写入受保护控制目录中以独占创建、禁止跟随符号链接、权限 0600 打开的普通文件。最终有效的 bwrap 退出记录确认 payload 已执行及其退出码；初始 child PID 不证明成功 exec。证据缺失或损坏保持 `unconfirmed`。信号/取消产生 `interrupted`；提升到后台的进程在独立结算 promise 完成前为 `running`。这些状态都不授权自动重试或脱离 bwrap 执行。

Relay 在 spawn 前检查父进程身份，并每 100 ms 检查父进程存活。Relay 退出后，bwrap 的父进程死亡处理终止私有 namespace。Scratch/control 资源在后台提升后继续保留，最终结算时删除。终止尚未确认的错误会保留资源用于检查。崩溃可能遗留目录；本层不实现恢复或垃圾回收。

## 受约束的文件 worker

安装后的 worker 从 stdin 接收以换行结尾、最大 16 KiB 的 JSON header，后面是二进制内容。Header 包含绝对目标路径，以及预期文件版本或不存在标记。版本记录设备、inode、大小和纳秒级修改/变更时间。二进制内容没有额外协议大小上限；可信调用者与 worker 将其缓存在内存中。

Worker 检查版本、创建父目录，并在 bwrap 内调用现有原子写入器，包括其提交前版本检查与权限模式处理。宿主客户端不打开目标进行写入，并同时验证可信执行状态与 worker 回复。只读策略拒绝写入。内核挂载限制约束符号链接遍历。版本检查能发现观察到的变更，但不提供抵御所有并发写入的文件系统 compare-and-swap 保证。

## 打包与涉及组件

改动为现有 core Shell 服务增加启动 API，添加 `packages/core/src/sandbox/` 下的底层模块、同目录单测和独立的 `scripts/sandbox-prototype/` 验证器。主 bundle 分别构建 relay 与文件 worker，包清单包含两份资源。模块构建解析相邻 worker，bundle 构建解析随包资源。资源缺失时在执行前失败。

本 PR 没有 runtime 配置消费者或 CLI 开关启用适配器。下一项依赖 PR 接入 runtime/工具，再进行完整 CLI 切换和公开入口 Linux 验收 workflow。将启用步骤后置，避免中间公开设置开启尚未覆盖完整工具的沙箱。Landlock 继续后置。

## 约束与风险

适配器仅支持 Linux，要求非特权 bwrap 可用。受限制的宿主 user namespace 策略可能需要操作者准备环境。库不修改内核/AppArmor 设置。共享 Shell 生命周期的改动需要覆盖现有调用者的回归，包括不使用 bwrap 的平台。

本层提供写入和命令网络约束，不承诺秘密保密性或完整宿主隔离：仍允许宽泛宿主读取和 pathname Unix socket。同用户可信宿主进程、沙箱外对工作区祖先的恶意修改、硬链接别名和整机崩溃清理不在该边界内。通用用户路径策略准入、权限、后端选择、模型/CLI 工具路由、Bun 独立二进制支持和 macOS/Windows 沙箱后端均不在范围内。

## 验证与验收

拆分分支必须通过构建、类型检查和打包。单测覆盖字面量 argv、精确/快照化环境、stdin EOF 与提前关闭、PTY 要求和 spawn 后不重放、状态解析、二进制 worker 分帧、版本检查以及客户端结果处理。现有 Shell 服务测试继续包含在回归中。

独立验证器必须在使用原生 PTY 的真实 Linux 上通过全部 34 项。它检查 namespace 标识、文件系统/网络隔离、字面量 argv 与引导环境、取消、超时、后台提升、父进程死亡、worker 写入及完成证据伪造。负向对照使用成功的宿主访问检查越界写入与网络拒绝判定条件。缺少前置条件即失败；mock 和数字 PID 不能单独证明约束成立。执行前后产物哈希与源输入清单标识被测候选。检查打包结果必须包含两个 worker；CLI 版本 smoke 仅验证打包，不代表公开沙箱启用。

运行 `node scripts/sandbox-prototype/build.mjs /absolute/empty/install`，为 Linux 架构安装锁定版本的原生 PTY 依赖，再执行该安装目录的 `verify.mjs`。使用可丢弃且互不重叠的安装、状态、工作区与临时根目录。在 PR 独立测试报告中记录本次结果；总 PR 的结果不能替代拆分分支的验证。
