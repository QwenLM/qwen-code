# Runtime 文件工具接入执行沙箱

[English](2026-09-16-runtime-file-sandbox.md) | [简体中文](2026-09-16-runtime-file-sandbox.zh-CN.md)

## 状态与问题

2026-09-16，继 [Runtime Shell 接入](2026-09-16-runtime-shell-sandbox.zh-CN.md)之后已实现的内部集成阶段。此前注册表仅开放 Shell 和 task_stop。此前原型文件 worker 只接受小型 UTF-8 JSON 写入，会替换符号链接，也不保留已有文件权限。此前生产 Write/Edit 还会在宿主创建目录。直接注册这些工具既会绕过约束，又会因为缺少 Read 的先读缓存而无法编辑已有文件。

## 范围与策略

保留现有仅可信宿主可注入的 bare 非交互准入和固定工作区权限上限。注册已有 Read、Write、Edit、Shell 和 task_stop 工具。本阶段不增加设置、环境开关或公开 CLI 参数，不实现 Landlock，也不移除旧的整个 CLI 沙箱。其他工具、hook、MCP、LSP、扩展和 worktree 副作用继续受上一阶段限制。此模式拒绝自定义文件系统委托，普通 runtime 的委托行为保持不变。

当前文件系统策略允许宿主读取，不承诺读取机密性。Read 保留原内容处理流程与基于 inode 的先读缓存。在 PDF 元数据探测、文本提取或栅格化启动任何宿主子进程之前拒绝 PDF 处理；用户可通过受约束的 Shell 调用相应工具。普通图片处理在内存中进行，宿主模型请求继续属于可信 runtime 行为。

## 写入执行

在 Write/Edit 最终写入处增加一个内部 runtime 写入 helper。无策略时继续委托已有 FileSystemService，并保留工具写入来源。有策略时复用现有文本编码器保留字符集、BOM 和换行，再通过已有受约束的管道启动把字节发给安装的 worker。目录创建移入 worker，跳过工具层的宿主 mkdir。只读策略拒绝文件变更，YOLO 也不例外。任何失败都不在宿主重试。

在读取或准备原文之前捕获预期普通文件版本：device、inode、size、mtime 和 ctime，使用 bigint stat 字段并序列化为十进制字符串；不存在的文件为 null。读取后绝不重新获取版本来替代它。worker 在创建目录或临时文件之前检查版本，并通过 atomicWriteFile 的 assertCanCommit 回调在提交前再次检查。目标变化、替换、消失或新出现时返回结构化的文件过期错误，要求重新读取。这缩小了新增 worker 启动带来的竞争窗口，但不是原子 compare-and-swap，也不为任意并发写入方提供锁。

将原型的 JSON 内容传输改为有限长度 JSON header、换行和原始编码字节。header 最多 16 KiB，校验操作、绝对目标路径和版本结构。内容不再受原型 1 MiB JSON 限制；工具仍使用现有内存文本准备流程。worker 复用 atomicWriteFile，保留 mode、fsync、跟随符号链接的行为及已有所有权/跨设备回退。工作区内链接和悬空链接保留原有语义；解析到可写授权之外的路径由内核拒绝。即使禁用先读缓存，也拒绝特殊文件。

worker 返回结构化成功或文件系统错误码。client 只有在沙箱回执已确认、退出码为零且回复有效时才接受成功；无法确认的完成绝不重放。保留普通工具错误、确认、替换匹配、diff 展示、artifact 元数据和写后缓存更新。已有署名记录仅更新宿主内存。明确启用文件历史时，备份继续作为可信 runtime 写入受保护的 session 存储；它不授权工作区写入或回滚工具。

## 影响代码与兼容性

Core Config 仅调整受限工具注册表/允许列表，并拒绝自定义文件系统服务。Write/Edit 捕获版本并路由最终变更。共享文件内容流程在策略下拒绝宿主 PDF 处理。worker/client 协议与 Linux 原型验证器同步修改；此 API 属于内部实现，没有公开兼容性承诺。复用编码与原子写实现，不重新复制。

历史 Runtime Shell 和 API 阶段证据继续以冻结 artifact 标识。本阶段重新构建两个 worker 资源，并在协议变化后重跑相应 Linux 验收。其他产出文件的工具、完整前端/副作用清单、读取机密性、hard link 的 inode 级不可变性和原子 CAS 不属于本阶段。

## 验证与验收

遵循仓库 feat-dev 和 e2e-testing 流程。实现前，用确定性的本地模型和临时 workspace/HOME/state 驱动全局 CLI，确认原有 Read/Edit 语义与未受约束的根外写入。区分普通安装 CLI 基线与内部策略 launcher。

单测覆盖默认委托、无宿主 mkdir/write 的策略路由、版本变化与目标新出现/消失、普通文件限制、worker 结构化失败和自定义 adapter 拒绝。保留已有 Write/Edit/Read 测试。在真实 Linux 驱动生产 Read/Write/Edit 回合，验证受限注册表、Unicode 与非 UTF-8 字节、BOM/CRLF、已有 mode、嵌套创建、允许和拒绝的链接遍历、只读拒绝、两个 runtime 上限，以及取消不重放。增加确定性的 worker 版本冲突测试和超过旧 1 MiB 上限的内容测试。证明 PDF 在辅助进程启动前被拒绝。重跑既有 Shell 生命周期与 adapter 测试。

验收要求 build、typecheck、bundle、定向测试、最终源码/artifact hash 一致、两轮干净自审及独立审查。精确结果与限制记录在 .qwen/e2e-tests/runtime-file-sandbox.md。本内部阶段没有未解决的设计选择。

## 验证结果

2026-09-16，实施前的全局 qwen 0.23.4 基线完成了七次真实 Read/Edit 调用。候选产物在 Lima qwen-sbx、ARM64 Linux 7.0.0-31-generic、Node 22.22.1、bubblewrap 0.11.1 上通过 31 组生产 headless runtime 检查和 34 组 adapter/worker 检查，覆盖原有 Shell 生命周期、私有 PID namespace 清理、文件语义、越界写拒绝和启动失败不在宿主重放。worker 套件通过了超过 1 MiB 的原始二进制内容、空内容、权限/符号链接保留、目标变化/替换/删除/新出现冲突和 FIFO 拒绝。

Build、typecheck 和 bundle 通过。定向 core 与 CLI 单测通过 3,328 项，另有一项原有跳过。runtime 产物的 4,791 个源码输入匹配，launcher SHA-256 为 `18a7a557bf41e8ecc3baa3de1a6826fccc21a7fb93cbac3f49584d83a362b8e1`。adapter 产物的 278 个输入匹配，其 worker SHA-256 `439e880137e0ef7ab383fb54f8d4f42804a406e363c6513468a102c7f90e3a18` 与生产 bundle worker 一致。精确证据与清理记录在 `.qwen/e2e-tests/runtime-file-sandbox.md`。

Linux 证据覆盖上述 ARM64 环境。Linux x64、其他内核、公开前端启用和 Landlock 尚未验证或实现。取消与不确定回执处理由现有真实 Linux adapter 生命周期检查和文件 client 单测拒绝路径共同覆盖；runtime 文件用例没有中断正在执行的文件提交。不承诺原子 compare-and-swap 或通用回滚。

两轮干净自审及独立审查未发现剩余可操作问题。打包预检包含两个安装 worker；预检后再次确认最终源码及 worker hash 一致。
