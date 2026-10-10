# 使用同一个已打开来源完成文件读取

[English](2026-10-09-file-read-source.md) | [简体中文](2026-10-09-file-read-source.zh-CN.md)

状态：从 [PR #13526](https://github.com/QwenLM/qwen-code/pull/13526) 的普通读取源组件提取，供独立评审；来源提交为 `950950311f102a745556debc261009af677b125c`。本切片基于当前 main，不依赖单独的 CSI 挂载生命周期 PR #13772。

## 1. 问题与目标

普通 `read_file` 调用可能分别通过路径获取元数据、识别类型和读取内容。如果这些操作之间路径被替换，元数据、缓存身份和返回内容可能来自不同文件。文本、SVG、Notebook、图片、音视频和原生 PDF 字节均可能重新打开路径；PDF 页数查询、文本提取和渲染也使用路径。已有的有界文本句柄操作强制采用文本分类，无法覆盖全部格式。

让一次完整读取始终使用同一个已打开来源，并将调用方取消传递到 PDF 操作。内容处理、helper 进程、缓存记账和最终 ToolResult 构造结束之前保留来源。维持现有逻辑路径、结果结构、格式支持和调用方兼容性。

## 2. 来源所有权与消费者

`FileSystemService.withReadFile` 是内部回调操作。请求包括逻辑路径、调用方 signal 和媒体投递选择（`inline` 或 `omni`）。真实 ReadFile 调用提供该选择，在缓存查询和内容 I/O 之前进入 producer。回调覆盖类型识别、内容处理、PDF 视觉桥接、缓存记账、记忆新鲜度和结果构造。

来源为封闭联合类型：路径，或借用的描述符及从该描述符捕获的元数据。Standard filesystem 是真实 producer。Linux 与 Darwin 的 inline 读取在打开前先 stat 路径。非普通文件，以及 size 为 0 的普通文件，留在路径来源上且不被打开：特殊文件的 open/close 本身带有副作用，而 procfs/sysfs 报告 size 为 0 时，读到 EOF 仍会返回字节。size 为正的普通文件以 `O_RDONLY | O_NONBLOCK | O_NOCTTY` 打开，再 stat 该描述符；若打开后的 inode 不再是 size 为正的普通文件，则改用路径来源。其余情况回调收到描述符，并在每个退出路径准确关闭一次。准入时选择路径来源不是描述符 owner 失败后的重试。获取失败保留普通带内文件错误。回调或清理失败保持可观察，owner 失败后不重试路径读取。完成失败或迟到取消会撤销未返回读取的缓存权利。

逻辑路径继续决定扩展名、MIME、展示和遥测。描述符元数据提供类型、大小和缓存身份。图片与未知二进制类型识别使用描述符的位置读取样本；读取失败不能转成仅凭扩展名识别的成功。父进程字节读取采用显式位置，处理短读、检查取消并停在捕获范围；文件增长不扩大该范围。

小文本复用已有完整缓冲区编码解码和范围选择，保留 BOM、UTF-16/32、GBK、换行和准确行数。大文本使用已有位置 UTF-8 扫描器。独立安全边界流式 reader 保留原扫描预算。描述符读取不为行数或记忆新鲜度元数据重新打开路径。Notebook 格式化消费已接纳字符串；图片概览将已接纳字节交给已有解码器与渲染器。SVG、原始图片/GIF、媒体和原生 PDF base64 保留既有解码及输出上限。

## 3. 兼容边界

Omni 投递以及 Linux、Darwin 以外的平台继续通过同一真实 Standard producer 使用路径来源。描述符来源拒绝 Omni 路径投递。ACP 不实现本回调，其既有文本委托和能力回退继续使用原链路。已安装 producer 不因 Config 而被绕过，ACP 不能继承 Standard producer。

Notebook、图片概览和 PDF 的既有路径入口继续供其他调用方使用。Read-many-files 保留有界文本契约。不增加 runtime selector、权限、持久化格式或迁移。

## 4. PDF 取消与 helper 生命周期

PDF 工具接受既有字符串来源或借用的 FileHandle。描述符调用经子进程 stdio 槽位 3 继承原 fd，并使用子进程自己的 fd 路径：Linux 为 `/proc/self/fd/3`，Darwin 为 `/dev/fd/3`。Windows 描述符调用拒绝，不复制输入，也不回退到原路径。

描述符 probe 与 helper 保留 ChildProcess，对 stdout、stderr 设上限，并在成功、错误、取消、超时或输出超量后等待 `close`。只有 exit code 不够。停止请求发送 SIGTERM；若直接子进程尚未退出，100 ms 后升级为 SIGKILL。取消传递到页数查询、文本提取和页面渲染，调用方不能在取消后继续回退操作。描述符所有权持续到完整回调返回。

渲染输出使用新建临时目录。描述符调用保留输出目录 fd，在消费和清理周围核对目录名字对应的设备/inode 身份。Linux 相对该 fd 打开输出叶子；Darwin 使用自有临时名称并检查身份。未知名称、符号链接和非普通文件拒绝。回调返回之前完成输出消费和清理，不确定所有权或清理失败保持可观察。这些检查不提供原子的路径清理保证。

字符串来源 PDF 调用保留既有命令 runner 与共享可用性 probe，其实际页数查询、文本提取和渲染接收调用方 signal；新增的直接子进程等待关闭保证属于描述符 runner。边界依据为 Node 22 的[子进程 stdio 和 close 语义](https://nodejs.org/download/release/v22.14.0/docs/api/child_process.html)及 [Linux fd 路径](https://man7.org/linux/man-pages/man5/proc_pid_fd.5.html)。

## 5. 验证与验收

先 dry-run 全局 CLI 基线，再比较当前 main 和候选编译产物行为。在观察/接纳后确定性替换路径，核对各格式原内容与元数据。覆盖编码/范围、短读、增长、取消、获取/回调/关闭错误、PDF 继承 fd 与迟到 close、输出上限及输出清理。检查普通 Omni、ACP、Windows 路径选择、原文本错误和 read-many-files 扫描预算行为。

运行 build、typecheck、bundle、相关 package 测试及适用 lint/format。完成两次连续干净的全量 diff 自审及独立代码评审。新基线和候选报告分别保留。区分真实 Darwin 描述符和子进程 PID、可控 helper、模拟平台路径、真实 Poppler 与 Linux 执行；各类别不能互相赋予验收资格。

验收要求真实 ReadFile 调用使用真实 Standard producer，描述符消费者保持已接纳文件身份，取消阻止未返回结果/缓存发布，自有描述符/helper/输出清理完成或报告失败。没有调用方的可选接口不能满足验收。提交 PR 及其独立 E2E 报告附带本轮验证结果。

## 6. 范围与限制

已打开描述符在路径替换后保持原 inode，但不是同 inode 并发写入的不可变快照。捕获范围约束父进程字节/文本读取，不约束继承 fd 的原生 helper 输入长度。继承描述符可能共享文件偏移，需要分别用重复真实 Poppler 调用核验 seek。直接子进程 close 不证明后代进程终止。

CSI 接纳与限制、保留文件历史、私有文件 worker、不可变授权、Hosted 执行、Java/SQL、冷恢复、退休、NodeUnpublish 和卷复用均在范围外。本普通 producer 不是私有挂载 authority。Fixture 或本地 helper 测试不能推断真实 Linux/CSI 或云验收。自动 merge 或 approve 不属于拆分任务。
