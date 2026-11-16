# Read 未变更去重与 1.0.0-preview 线的合流

[English](read-dedup-convergence.md) | [简体中文](read-dedup-convergence.zh-CN.md)

状态：已实现设计，2026-11-16。随占位文案更新与区间读去重的变更集一同提交。

## 问题与现状

"该文件已读过、不必重发内容" 的去重在两条产品线上各有一份实现：

- **main** —— 独立的 `FileReadCache` 服务（inode 键控、只存元数据）。fast-path 仅对无参数整读且整文件视图仍驻留历史时返回占位符；占位文案是一段带前提说明的长文，结尾给恢复指令。auto-memory 文件只记录、永不返回占位符。驻留性在每个"内容未达模型历史"的站点解除：空闲 microcompaction 清空、压缩驱逐、执行环境失效、code_mode 嵌套读。
- **v1.0.0-preview** —— 文本读路径开头的一段短路：对重复的相同 `offset`/`limit` 请求按仅 mtime 的指纹去重；返回一句直接的 "Wasted call — file unchanged since your last Read. Refer to that earlier tool_result instead."；提供调用级 `dedupUnchangedReads` 退出开关；结果带结构化 `file_unchanged` 载荷。

逐行审计发现 preview 的缺口（仅 mtime 指纹、去重未排除记忆文件、tool-result 预算截断未同步驻留标记）与 main 的缺口（同区间重读总是重发模型已持有的字节、无结构化占位结果、无调用级开关）。本次合流只纳入能在 main 干净落地的两项 preview 优点，其余附理由延后。

## 决策

### 1. 占位文案：preview 的底句 + main 的恢复路径

新文案：`Wasted call — file <path> unchanged since your last Read. Refer to that earlier tool_result instead. If you cannot retrieve that earlier result (e.g. after context compaction) or suspect the file was modified outside the read/edit tools, re-read with explicit offset/limit.`

追加句是功能性的而非礼貌性的：不带参数的重读会再次满足 fast-path 条件、返回同一条占位符，因此显式 `offset`/limit 重读是脱离去重循环的唯一出口；compaction 例子点出 "refer to that earlier tool_result" 必然失效的唯一场景。去掉任子句（preview 文案的现状）会让模型没有退路。

### 2. 区间读去重，附加于现有整读半区之上

- 读管线新增 `contentLengthTruncated`，与既有合并标志 `isTruncated` 分离：后者对"请求被完整满足的显式切片"也为真，无法区分"上限截断了视图"与"请求本身要的是切片"。
- `FileReadEntry` 新增记录视图：`lastReadRange`（`'full'` | `{ offset, limit }` | `undefined`）与 `lastReadRangeResident`。仅对纯文本、未被上限截断的读记录视图；pages（PDF）读不记录，因为页视图与行区间不在同一轴上。最近一次读覆盖视图。
- fast-path 的整读半区保持字节级不变（sticky `lastReadWasFull` + `readResidentInHistory`），新增区间半区：视图精确相等 + `lastReadRangeResident`。两个半区都保留 mtime+size 新鲜指纹、`lastReadCacheable`、写新于读三项检查。
- `markReadEvictedFromHistory` / `markAllReadsEvictedFromHistory` 同时解除两个驻留标志，清空区间读结果与清空整读结果一样杀死其回引资格。
- 被上限截断的视图永不记录：上限是会话设置而非文件属性，磁盘指纹无法承诺后续读得到同样的截断位置。

### 3. 延后到 follow-up issue 的两项及理由

- **结构化 `file_unchanged` 结果。** main 的 `ToolResult` 没有 `toolUseResult` 通道，也没有任何消费方读它；只加单个生产者会造出死通道。需要跨包契约变更，且同一变更内至少接一个消费方（Web Shell 或 SDK）。
- **调用级 `dedupUnchangedReads`。** main 没有调用上下文 API；目前唯一非模型面向的 ReadFileTool 调用方是 managed CSI file worker 的宿主驱动 retirement/composition 流，其 Config/FileReadCache 共享语义需 managed 域复核后才能接退出开关。先加开关而无 setter 即为死开关。

## 约束

- 整读占位行为不变：同样的标志、同样的顺序、同样的排除项（auto-memory、code_mode 嵌套读、会话级缓存禁用逃生口）。
- 区间半区不得加宽无参数 Read 的回引范围；它只为模型确实收到过的视图增加回引。
- `priorReadEnforcement.ts` 不得开始读取新字段：写前读只需要"模型看过文本"加当前指纹。

## 验收

- `fileReadCache.test.ts`：满足的区间读与未截断整读记录视图；上限截断、非文本读不记录；最近读覆盖；两个 evict helper 解除区间驻留。
- `read-file.test.ts`：相同区间重读返回占位符且不回显字节；不同区间返回内容；首视图被上限截断则永不去重；整读插在两次区间读之间时先重发一次再恢复去重；evict 后重发字节。
- 五个钉住旧文案的测试文件改断言新文案。
- 既有整读、evict、嵌套读、二进制、microcompaction 套件保持全绿。
