# VS Code 会话存储

[English](2026-10-15-vscode-conversation-storage.md) | [简体中文](2026-10-15-vscode-conversation-storage.zh-CN.md)

## 问题与范围

Issue #14262 报告 `globalState.conversations` 已达到 75 MB。每条消息都会重写所有
会话，包括废弃的空占位会话。保持 companion 现有会话 API 和 daemon 历史行为不变。

## 存储与迁移约定

每个会话以 JSON 存入 `globalStorageUri/conversations`，使用 ID 的 SHA-256 哈希
作为文件名。扩展运行在 Node extension host 中（WSL 下也在远程 host 中运行）。
使用 Node 文件系统 API，无需新增存储依赖或全局索引。

同一个 extension host 中的所有 store 实例串行执行操作。修改时只读取目标会话。
替换记录时复用 core 原子写入工具（含刷盘和 Windows 重命名重试）；迁移和会话 ID
重命名先刷盘唯一临时文件，再通过排他硬链接发布，避免覆盖已有目标。临时文件和旧 ID 源文件的清理
采用尽力而为的方式，不得掩盖发布结果；清理失败可能留下多余文件。不同窗口的不同会话写入不同文件。不同
extension host 同时编辑同一会话仍与此前一样采用最后写入者生效的语义；本次不新增
跨进程会话锁。

正常操作前迁移所有旧记录，不覆盖已有目标；完成后只删除 globalState 中的
`conversations` key。读取或写入错误向上传递，旧 key 保留供重试。重试时先读取并验证已有目标记录，不重新写入已迁移的记录。损坏的 JSON 报错，不当作空会话处理。信任边界为扩展自身写入的旧记录；
文件名使用哈希，ID 无法越出存储目录。

每个 store 实例只在内存中保留当前新建的空草稿。第一条消息到来后持久化；废弃的新草稿不保留。旧空记录无法可靠地区分占位与首轮编辑暂时清空的会话，因此全部保留。已持久化的会话可能在编辑第一轮时暂时变空，必须继续可用，
以便替换消息或回滚。非空历史不按年龄或数量淘汰：自动删除用户消息不在本次范围内，
有效历史的磁盘占用仍可增长。

## 调用方与验证

`WebViewProvider` 创建草稿并追加后台通知；`SessionMessageHandler` 创建、读取、
追加、插入或更新、重命名、截断和恢复会话。保持其调用签名不变。handler/router
包装层只传递 store。`getAllConversations` 没有外部生产调用方。

回归测试使用真实临时目录，覆盖迁移和重启、迁移失败和重试、新草稿清理、原子写入
失败、多 store 并发、ID 重命名、首轮编辑和恢复，以及追加回复时其他会话文件保持
不变且不向 globalState 写入正文。用相同脚本输入比较修改前后的实现。CLI 无法
触达 VS Code Memento 存储；缺少对应运行环境时，单独说明未验证 extension host/
WSL 告警。
