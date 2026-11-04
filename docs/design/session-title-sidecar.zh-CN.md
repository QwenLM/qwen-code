# 会话标题 sidecar

[English](session-title-sidecar.md) | [简体中文](session-title-sidecar.zh-CN.md)

状态：已实现。日期：2026-11-04。

## 问题

会话在侧栏中的名字完全来自 transcript：服务端从 `custom_title` 记录取
`customTitle`，否则回退到前十条记录中的首条用户 prompt。当 transcript 丢失头部
时——文件被删除后由写入器在下次追加时重建、崩溃截断、或 chats 目录被外部清理
——首条 prompt 不存在了，`displayName` 变成空字符串，Web Shell 只能回退到会话
id 的前八个字符，而那不是名字。

实际案例：一个 live 会话的 transcript 在 15:57 被重建，只剩 `ui_telemetry` 与
后台任务通知，列表行显示 `9d68a0dc`，尽管该会话创建时有正常的 prompt。

## 目标

- transcript 丢失头部时，列表标签仍然可用。
- 用户手动改的名字在 transcript 重建后仍然保留。
- 不再把裸会话 id 当作会话名显示。

## 非目标

- 从已经不存在的 transcript 重建历史。
- 改变 `custom_title` 记录在 transcript 中的存储方式。
- 改变从未有过名字的会话的重命名或搜索行为。

## 方案

在 transcript 旁边增加按会话的 sidecar：

```
<projectDir>/chats/<sessionId>.title.json
```

```json
{
  "version": 1,
  "displayName": "CI 验证与复验",
  "source": "prompt",
  "updatedAt": "2026-11-04T09:44:49.085Z"
}
```

`source` 取 `prompt`、`auto` 或 `manual`。

### 写入时机

- `ChatRecordingService.recordUserMessage` 在首条真实用户 prompt 时写入
  `source: "prompt"`，按列表读取使用的 200 个码点上限截断。后续 prompt 不覆盖。
- `ChatRecordingService.recordCustomTitle` 写入自定义标题及其来源。`prompt`
  条目永远不会覆盖 `auto`/`manual` 条目，因此重命名不会被后续 prompt 冲掉。
- `SessionService.renameSession`（没有 live recording 时使用的回退路径）在追加
  `custom_title` 记录后写入 sidecar。
- Managed 会话日志跳过：它们自己管理元数据投影。

### 读取时机

- `SessionService.getSessionTitleInfo` / `getSessionTitle` 在 transcript 没有
  自定义标题时，返回 `manual`/`auto` sidecar 中的标题。
- `SessionService.listSessions` 与 `getSessionListItem` 在 transcript 没有首条
  prompt 时，使用 `prompt` sidecar。
- `SessionService.getSessionDisplayName` 在 transcript 读取损坏后回退到 sidecar。
- transcript 仍是权威来源：可读的 `custom_title` 记录或首条 prompt 始终优先。

### 生命周期

- 归档 / 取消归档时 sidecar 随 transcript 一起移动。
- 删除会话时删除 active 与 archived 两个位置的 sidecar。
- 会话存储迁移到另一个 runtime base directory 时带上 sidecar。

### Web Shell 兜底

`displayName` 为空时，侧栏行显示本地化的 `sidebar.untitledSession`（英文
“Untitled session” / 中文“未命名会话”），不再显示 id 前缀。搜索匹配与删除确认
仍保留 id 回退，因为那里 id 是唯一的稳定标识。

## 设计决策

- **使用 sidecar，而不是重写 transcript。** 重新插入 prompt 记录会伪造模型可
  回放的历史；sidecar 只是元数据。
- **只存首条 prompt。** 存所有 prompt 会重复 transcript 并撑大 chats 目录；首条
  prompt 本来就是列表使用的标签。
- **best-effort 写入。** sidecar 写失败绝不能导致 prompt 或重命名失败；缺失的
  sidecar 视为“没有持久化标签”。
- **热路径不新增读取。** 只有 transcript 既没有标题也没有 prompt 时才读 sidecar。

## 风险

- 部分写入后 sidecar 可能与 transcript 不一致。读取优先 transcript，因此可见
  名字仍是权威值。
- sidecar 包含首条 prompt，可能含敏感文本。它与 transcript 同目录（权限
  `0600`），暴露面相同。
- 如果会话在服务之外被删除，可能留下孤儿 sidecar。会话扫描只接受
  `<uuid>.jsonl`，因此这些文件会被忽略。

## 验证

- 单测覆盖：往返与校验、无头 transcript 的列表回退、重命名优先、删除会话、
  首条 prompt / 自定义标题写入。
- 真实 daemon 场景：用假 OpenAI 兼容端点启动隔离的 `qwen serve`，发送一条
  prompt，把 transcript 替换成单条 `ui_telemetry` 记录，重启 daemon，确认列表
  仍显示 prompt 推导出的名字；再重命名会话，再次替换 transcript，重启后确认
  manual 名字保留且 `titleSource: "manual"`。

## 验收标准

- 在本改动之后，有首条 prompt 或自定义标题的会话，其 transcript 丢头或被重建
  时不再产生空的 `displayName`。
- 手动重命名在 transcript 丢失后仍然保留。
- 没有 sidecar 的会话显示中性标签，而不是 id 前缀。
- 归档、取消归档与删除会话后，sidecar 状态与 transcript 保持一致。
