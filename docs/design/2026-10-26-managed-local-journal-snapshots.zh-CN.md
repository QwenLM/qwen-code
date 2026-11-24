# 本地 Managed journal 快照恢复（PR4）

[English](2026-10-26-managed-local-journal-snapshots.md) | [简体中文](2026-10-26-managed-local-journal-snapshots.zh-CN.md)

## 问题与边界

Issue #13184 需要先建立原生恢复边界，才能淘汰 authority 状态。本地 journal 当前
读取完整 JSONL 文件，而 writer lease 同时认证物理 transcript 字节和逻辑提交证明。
适配器不能独自 rename 文件，否则会使 writer 的证明失效。

本片把完整已提交前缀移入不可变 Session 资源，将活跃文件替换为原 ownership/header、
一条快照 base 记录及连续的后续尾部。仅在正常 sealed 的本地 Session 下一次恢复时
转换一次，发生在最终恢复投影、activation 安装和 recorder 绑定之前。新 Session、运行中
Session 和只读请求不转换。未提交尾部沿用现有恢复流程，不纳入快照。

不包含自动轮换、垃圾回收、紧凑 authority 状态或内存淘汰。完整历史和 authority 索引
仍会增长。PR2/PR3 定义远端快照恢复；本地信封保存相同源事实，不伪造服务端 revision
或 writer generation。

## 表示与接口

本地 manifest 绑定格式、Session key、有序不可变 page refs、完整前缀长度与 SHA-256、
提交 sequence、commit digest、最后 record UUID、资源闭包及最新 title/source refs。
页面保存准确 JSONL 字节，以事务边界结束，每页最多 16 MiB。Manifest 与页面使用专用
resource kind 和内容派生 ID，位于既有 Session resource root。发布幂等且耐久，拒绝
已存在的冲突字节；既有资源大小限制仍适用。

物理文件保留原 ownership 首记录和 Managed header，随后是唯一的
`managed_session_snapshot_base_v1` 与后续事务。Base 使用独立 UUID，是已知的
non-conversation 控制记录，不进入逻辑历史；其 manifest ref 认证完整前缀。事件与
逻辑 header 格式仍为 1，仅物理 header 要求 `managed-session/2`。读取能力与新建
普通 Session 使用的最低读取版本盖章分离。

统一本地 writer 获取/准备入口服务适配器、authority 和 Config。Config 先验证已有恢复投影的准入和归属，再转换并重新获取最终投影；无效恢复请求不得改写主日志。只读静态读取不会执行转换。
`SessionWriterLease.replaceManagedTranscript` 执行带 owner 校验的替换，既有 Legacy
替换方法继续拒绝 Managed。本地读取显式接收 runtime base、Session key 和可选的冻结
物理字节边界。公共 HTTP journal 接口不增加本地专用选项或 hook。

实现分为本地 writer 准备、原生快照重放封装与文件系统/显示编解码器。
公共 `managed-session-resource-references` 模块枚举 schema 明确声明的路径；channel
输入包含附件 ref，其 opaque reply context 与普通用户 JSON 保持为数据。
既有 HTTP 收集器保持原有行为。

## 转换与耐久性

1. 认证 sealed 前任的物理证明及逻辑提交证明。仅非空、完整已提交且没有 base 的 v1
   源日志具备转换资格。
2. 安装 schema 3、本地 `format_version=2` 的 writer，并在安装新布局前同步锁目录。
   新建普通 Session 保持格式 1；转换后的获取、seal 和 reclaim 不得降级。
3. 验证 schema 声明的 header/event 引用，通过 resource kind 解析器展开深层依赖。
   先发布页面，再发布 manifest。任意 JSON 外形不是依赖，同一 ID 的冲突引用应拒绝。
4. 写入并同步临时主文件，复核 owner 与源哈希，rename、同步父目录，重新固定 inode、
   元数据和 rolling hash。
5. 重读安装后的快照与尾部，验证原 sequence、marker digest、最后 UUID 和命令重放
   事实，再准入新工作。

Rename 前失败保留旧文件并返回错误；结果不确定或安装后验证失败时停止写入并保留围栏。
Abort/release 不得删除格式 2 barrier；经过验证的失败打开可以恢复原逻辑 seal。缺失的
页面、manifest 或依赖属于损坏，不能当空 Session，也不能回退另一个 head。格式 2 的
锁 claim/primary 转换必须在移除保护 claim 之前同步目录。进程崩溃测试不证明掉电耐久性，
也不代表未测试文件系统获得资格。

此完整性门禁同样适用于被选择转换的既有 sealed v1 Session。声明依赖缺失、截断或摘要
不一致时，即使旧读取器曾容忍这些损坏，也必须在 activation 前阻断恢复。原 transcript
保持不变，格式 2 barrier 保持 sealed；不提供兼容绕过或自动裁剪。恢复引用所指向的原始
资源字节后，下次恢复可以重试同一份历史。未转换 v1 transcript 的静态查看保留原读取语义，
且不触发升级。Journal handle 首次 read 可以准备转换，是因为该 handle 已持有 writer，
属于恢复操作；abort 会封存其证明，而不是删除已升级的 barrier。

## 读取与兼容性

逻辑 scan 包含完整事件、事务和恢复事实。快照读取同时校验 manifest 资源清单和已提交尾部
的完整资源闭包；未提交及冻结边界外的引用不会被准入或读取。`maxBytes`、`committedBytes`、`headerBytes`
和 `uncommittedBytes` 继续描述当前物理文件，确保尾部修复截断准确字节。一次读取只接受
同一已验证文件 generation；冻结游标保留 inode/长度契约，替换后返回既有 409。

Authority、恢复/历史投影和失败打开收尾共享快照读取器。同步 title/source 先扫描完整
已提交物理尾部，再使用 manifest 锚点，明确接受 O(tail) 成本。受控地读取完整 header/base，
不能假定它们位于 64 KiB 显示窗口内。保留首记录项目授权和既有 Legacy 专用入口拒绝。
Archive/unarchive 不移动资源，永久删除沿用整棵 Session 资源目录清理。

版本 barrier 防止旧 writer 接管与执行。既有旧维护读取器没有版本上限，因此应保证
archive/delete 安全，不能声称所有旧操作都被阻断。只读兼容失败不得被识别为 Legacy
或新 Session。

## 验证与验收

- 准确字节和多页恢复、原 receipt 与冲突拒绝、checkpoint/activation/嵌套资源、重复
  恢复仅发布一次。
- 冻结字节边界、UTF-8、空尾部、未提交尾部物理截断、追加连续性，以及逻辑/物理 seal
  证明。
- Barrier 安装、发布、write/fsync、rename、证明更新故障，以及独立进程崩溃和新旧 writer
  兼容。
- 替换时分页、大 header、埋在显示窗口外的 title/source 更新、archive/unarchive/delete，
  及缺失、损坏、跨 scope、symlink 依赖。
- 聚焦 Core 回归、根 build/typecheck/bundle、格式与 lint、两轮干净自审及独立审查。

全局 CLI 能力检查只用于发现基线。没有原生快照操作入口时，通过适配器/进程测试覆盖
实际契约。已执行结果以测试 revision 记入 E2E 报告。本设计不代表 Linux/Windows、
掉电或生产验收。
