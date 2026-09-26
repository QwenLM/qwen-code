# Managed 工具结果本地分段存储（O1b）

[English](2026-09-26-managed-tool-result-local-store.md) | [简体中文](2026-09-26-managed-tool-result-local-store.zh-CN.md)

## 问题与范围

[O1a](2026-09-26-managed-tool-result-contract.zh-CN.md)定义了不可变分段身份、发布、封存、manifest 和 page，但只实现了内存参考账本。`LocalManagedSessionResourceStore` 以整块 Buffer 发布和读取。因此，100 MiB 的工具输出还没有内存有界、可在进程替换后读取的本地存储。

O1b 增加归 Session 所有的私有本地分段存储。它不挂载 Tool v3 路由、不捕获 Shell 输出、不增加托管存储，也不开放公共预览。O1c 连接前台生产者；O2 增加远程存储和容量策略；O3 将结果投影到 Java 和 WebShell。本实现支持每个 Session 单写入进程、通过一个串行 writable handle 接收多个工具的并发提交、任意数量的只读 handle，以及写入进程退出后的重新打开。

## 接口

`ToolResultSegmentStore` 提供异步 `publish`、`seal`、`prefix`、`readRange` 和 `close`。前三项沿用 O1a 的请求校验、回执及 `invalid`、`conflict`、`digest_mismatch` 结果。内存账本保留为行为参照；本地适配器不在内存保存整次捕获。

`publish` 在排队前复制一个调用方分段。单段为 1–16 MiB；生产者在复用 Buffer 前等待回执。`seal` 仅接受准确齐全的序号和匹配的总长度、摘要。`prefix` 覆盖从序号零起最长的已校验连续区间。这三项在 writable handle 上串行执行。`close` 拒绝新操作并等待已接收操作完成。调用方在释放 `SessionWriterLease` 或删除 Session 前关闭存储；O1c 接入此生命周期。存储要求传入现有 lease，校验其 Session 与 runtime 根目录，绝不再次获取 lease。

`readRange` 接收 `manifestRef`、调用方预期的完整执行身份、`streamId`、offset 和 length。读取固定在该不可变 manifest 版本，返回精确的 Buffer，拒绝超出该版本描述符边界的请求。单次读取上限为 16 MiB。空读取仅在合法边界内允许。返回前校验完整 manifest 身份、page 位置、分段身份、长度及摘要。对 `body.pages` 校验相关分段；对 `body.ref` 流式读取并校验整份资源，只保留请求范围。I/O 故障保持为失败，不能伪装成空结果。

## 持久布局与恢复

存储在 `managedSessionResourceRoot` 下拥有独立的版本化 namespace。不可变 owner 记录保存完整 `ManagedSessionKey`；使用其他 tenant 或 workspace 打开会失败。capture 与 stream 路径组件使用通过 O1a 校验的 token，并加固定前缀。runtime 根目录由调用方控制；资源根下创建的目录须检查符号链接。

每个 ordinal 对应一个包含原始 bytes 和接收方计算回执的不可变目录。候选内容先写入同一文件系统、权限私有的 staging 目录。同步文件和 staging 目录后，以不替换既有 ordinal 的方式安装并同步父目录。随后在 stream 目录写入并同步不可变的 ordinal 发布标记，才返回回执。namespace 中另有不可变 stream 锚点，以便整个 stream 目录丢失后仍能识别它曾被确认发布。seal 也按相同目录规则发布，并在返回回执前写入 namespace 级不可变 seal 锚点。锚点文件名使用固定长度摘要，并记录原始身份或回执。新建及既有祖先目录都按依赖顺序同步，包括前一次同步失败后的重试。目录同步遵循仓库明确的平台策略；不能把不支持的持久性保证默认为已实现。

重新打开时忽略尚未提交的 staging 目录。分段存在不代表流已封存；相同内容在回复丢失后重试，须验证内容并补齐缺失的标记或目录同步，才返回原回执。发生冲突或摘要不符的新候选被隔离，不能进入读取路径，原分段保持不变。发布标记可发现缺失的分段目录；namespace 锚点可发现缺失的 stream 或 seal 目录。损坏的已发布分段不能被替换；只读方拒绝，写入 owner 复核后记录持久损坏标记。O1b 不删除孤儿、staging 或隔离数据；Session 删除沿用既有所有权检查并删除整个资源根。

page 和 manifest 正文继续使用现有 Session 资源存储。O1c 根据已校验分段回执构造这些正文；O1b 测试使用 fixture。读取校验引用摘要及请求的精确版本，不查询可变的 latest 指针。`prefix` 和 `seal` 以有界缓冲扫描文件计算摘要，不保存整条输出，也不增加摘要 checkpoint。

## 验证与验收

- 将 O1a 的 28 组分段序列（136 步）同时运行于磁盘适配器和内存账本，覆盖畸形结构、乱序、重复发布、冲突和空流封存。
- 从增量数据源以 4 MiB 测试分段发布 100 MiB 流并验证保留内存有界；与 1 GiB 流对照，不在内存构造完整输入或期望输出。4 MiB 是测试输入，不是产品默认值。
- 读取跨分段和跨 page 的二进制范围，包括跨分段的 UTF-8 字符、空范围、越界，以及新版发布后读取旧版 manifest。覆盖 `body.pages` 和 `body.ref`。
- 在 staging 写入期间、安装后回复前、seal 前后模拟重启及进程丢失；重开后仅看见持久分段和显式封存。
- 注入写盘和同步失败、破坏已发布文件、替换路径或 owner 身份、重复打开 writable handle，以及存在排队操作时关闭。正确重试不能替换字节，也不能把未同步结果称为已持久化。
- 运行相关 core 单测、构建、类型检查，以及既有 O1a、Session 资源存储与 Tool v3 准入回归测试。

O1b 尚无 CLI 或公共 API 入口。真实进程检查使用本地子进程测试工具，不以模型对话替代。此阶段在途分段数量由生产者约束；全局容量和租户配额在 O2 实现。

## 风险与后续

读取较大的 `body.ref` 时，每个有界范围都要校验整个文件，以更多 I/O 换取有界内存。适配器假设 runtime 根目录私有且每个 Session 只有一个写入进程；跨进程同时发布和跨主机持久性需要后续托管存储设计。O1c 必须在放弃既有 Session lease 前关闭并排空 writable handle。O4 定义按引用清理。
