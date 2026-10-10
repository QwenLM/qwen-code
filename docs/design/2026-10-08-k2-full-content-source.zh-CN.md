# K2：完整文件读取只使用一个获准来源

[English](2026-10-08-k2-full-content-source.md) | [简体中文](2026-10-08-k2-full-content-source.zh-CN.md)

状态：普通来源组件已实现并完成本地验证，2026-10-08。基线为
[Draft PR #13526](https://github.com/QwenLM/qwen-code/pull/13526) 中的
`0b15333a1390ed4ce723aa8f7175422cac955425`。
本组件扩展[原生文件执行设计](2026-10-07-k2-native-file-execution.zh-CN.md)，
不开放私有文件准入，也不代表完整 K2 已通过验收。

## 1. 问题与当前行为

`read_file` 先对路径执行 stat，再分别按路径分类和读取。文本、SVG、
notebook、图片、音频、视频和原生 PDF 消费方都可能重新打开该路径。
PDF 页数查询、文本提取和页面渲染也接收路径。准入后替换文件，可能让
元数据、分类和内容来自不同文件。现有有界文本句柄选项强制按文本分类，
不能覆盖完整格式。

mount owner 已能等待获准观察操作结束，但实际文件工具尚未借用该 owner。
本组件先提供真实的完整读取消费方和普通文件系统生产方，再实现私有后端。
现有私有 worker 和公开选择器的拒绝门禁全部保留。

## 2. 生产方与所有权

在 `FileSystemService` 增加内部回调操作。请求包含逻辑路径、取消信号和
必填的媒体交付选择（`inline` 或 `omni`）。实际 ReadFile invocation 根据
Config 提供该选择，在缓存查询和其他文件 I/O 之前进入该操作。回调覆盖
分类、内容处理、PDF vision bridge、缓存记录、memory freshness 和最终
ToolResult 构造。

来源采用封闭判别联合：路径，或借用的描述符及从该描述符取得的元数据。
Standard 文件系统是两个分支的真实生产方：Omni 及 Linux、Darwin 之外的
平台沿用现有路径链路；Linux、Darwin inline 只打开一个非阻塞读取描述符，
执行 fstat，并持有到整个
回调结束。所有退出路径只关闭原描述符一次。获取失败保留普通文件的带内
错误；owner 或 close 失败保持可观察，绝不按路径重试。owner 完成失败，
或迟到取消导致结果未返回时，调用方使相应的缓存读取权限失效。

ACP 不实现此回调操作，其现有文本委托和 capability fallback 继续使用
原链路。不得让 ACP 继承 Standard 生产方，也不得根据 Config 绕过已安装
的生产方。

后续私有 Linux 后端只能产生描述符分支，在文件 I/O 前拒绝 Omni。它必须
让整个回调受原 mount 准入约束，并在身份不确定时永久阻断 owner。
本组件的 Standard 描述符不是私有 mount 权限证明。

## 3. 分类、字节与文本

逻辑路径继续决定扩展名、MIME、显示和遥测；描述符元数据决定文件类型、
大小和缓存身份。图片和未知二进制分类从该描述符按明确位置取样。
描述符错误不能静默变成仅靠扩展名的成功分类。

全部描述符字节读取都指定位置，处理短读，检查取消，并止于已捕获的大小；
文件增长不扩大本次读取。保留现有 SVG、媒体、base64、PDF 和图片解码器
上限。不得把输入复制到临时路径。

持有同一 inode 不等于对同 inode 并发原地写入的不可变快照。捕获大小
限制父端字节/文本读取，不构成对原生 helper 继承描述符的输入长度限制。
私有后端的 writer 排他与 helper 资格仍是独立门禁。

小文本复用现有完整 buffer 编码解码器和行范围选择，保留 BOM、UTF-16/32、
GBK、换行格式和精确行数。大文本使用现有按位置读取的 UTF-8 扫描器。
不改变独立安全边界流式读取器的扫描预算契约。不按路径补读行数或 freshness
元数据。

Notebook 格式化增加真实的字符串输入消费方。图片 overview 增加真实的
Buffer 输入消费方，复用路径入口的准备和渲染逻辑。原始图片/GIF、音视频
和原生 PDF base64 使用同一个借用来源。其他调用方仍可使用现有路径入口。

## 4. PDF helper 生命周期

PDF 工具继续接受真实旧调用方使用的字符串来源，包括 web fetch。描述符
调用通过子进程 stdio 继承原描述符，并访问子进程自己的 fd 路径：Linux 为
`/proc/self/fd/3`，Darwin 为 `/dev/fd/3`。Windows 描述符调用明确拒绝，不
回退路径。禁止父进程 fd 路径和临时输入副本。父端分类、字节读取仍指定
位置；重复真实 Poppler 调用必须验证 seek 行为，因为重复描述符可能共享
offset。

描述符 runner 持有 ChildProcess，限制 stdout/stderr，拥有 availability
probe，并在成功、错误、取消、超时或输出溢出后等待真实 `close` 事件。
拿到退出码或回调不等于完成 join。取消信号传至页数、提取和渲染。渲染
输出仍放在独占临时目录，输出读取和清理都在回调返回前完成。描述符输出
持有目录 fd，并在消费和清理前后核对目录名称的身份。Linux 按目录 fd
打开叶子；Darwin 使用独占临时名称及身份检查。叶子拒绝符号链接和非普通
文件。目录所有权不确定或清理失败保持可观察。这些普通临时目录检查尚不
构成已验证的私有 scratch owner，也不保证按路径清理的原子性。

这些选择依据 [Node 22 子进程 stdio 与 close 文档](https://nodejs.org/download/release/v22.14.0/docs/api/child_process.html)
和 [Linux fd 路径文档](https://man7.org/linux/man-pages/man5/proc_pid_fd.5.html)。
直属子进程 close 不能证明后代已终止、CSI NodeUnpublish 或卷可安全复用。
私有后端准入 PDF 前还须验证 helper 进程族及临时输出清理，包括持久阻断。

## 5. 影响组件与验证

影响层包括 FileSystemService 和 ReadFile invocation；文件类型、字节与
文本工具；notebook 和图片输入适配；PDF helper；以及对应同目录测试。
现有 read-many-files 有界文本处理仍是独立消费方，保留原安全契约。

验证在打开后替换路径，检查所有格式仍读取原内容和元数据；覆盖编码与行
范围、短读、增长、取消、获取/关闭错误、PDF 继承 fd 与延迟关闭、输出上限
和清理。回归检查覆盖 ACP、普通 Omni、Windows 路径选择、不变的文本错误
和私有入口拒绝。先验证全局 CLI 基线；模型提示无法确定触发准入竞争时，
再使用独立脚本验证。

仍须完成 build、typecheck、bundle、包内定向测试、两轮完整自审和原生
review。真实 Linux/CSI/Poppler 覆盖必须与 Darwin fixture 或受控 helper
程序分别报告。

独立本地验证完成 40 组有界 built-entry 观察：28 组内容/来源/生命周期/
兼容性，以及 12 组真实继承 fd、child close 和输出所有权。它观察真实
child PID 与自有描述符，完成清理后才解除输入冻结。媒体转发、受控
transport/平台/错误 adapter 及受控 helper 程序分别标注。21 组基线观察
保留四次脚本/断言失败及纠正补跑，不算 21 个通过的产品场景。这些报告
不代表真实 Poppler、Linux/CSI 或 K2 资格。要求的原生 review 无法在当前
宿主调度生成的 workflow，不宣称独立审查结论或批准。

## 6. 验收与剩余 K2 工作

只有真实 ReadFile 调用方使用真实生产方、所有描述符消费方在 join 完成前
保留原字节且不恢复路径读取，本组件才可验收。双语文档必须记录相同的
实现和验证状态。没有调用方的可选接缝不算完成。

私有目录 fd 后端、保留原字节的文件历史、封闭三工具工厂、SQL/native/
Hosted 链路、完整 writer 清点和 drain、物理 writer/后代终止、逐 target
NodeUnpublish、原子 RELEASED 与安全交接，仍须按父设计完成。公开选择和
新一轮完整云上验收仍关闭。本来源组件本身不能满足这些门禁。
