# 外部记忆导入 API v1

[English](external-memory-import-api.md) | [简体中文](external-memory-import-api.zh-CN.md)

## 能力与归属

检查 `/capabilities` 中的 `memory_import_v1`，从 `workspaces` 列表选择可信且活动的工作区。以下路由均位于 `/workspaces/{workspaceId}/memory/import`，不存在隐式主工作区入口。沿用 daemon 工作区路由的认证、origin/CSRF 和变更授权。响应私有且不可缓存。v1 不支持 SSH 工作区及旧式 `QWEN_CODE_MEMORY_BASE_DIR` / `QWEN_CODE_MEMORY_LOCAL` 路径覆盖配置，遇到时明确拒绝。本次不修改 DataAgent 或其他宿主产品。

## 来源与离线预览

来源结构为 `{version:1, source:"codex", files:[{path,content}]}`。路径相对于选中的 Codex memories 文件夹。接受 `MEMORY.md`、`memory_summary.md` 及被引用的 `rollout_summaries/*.md`；这些是整理后的 Markdown，不是原始会话 JSONL。排除符号链接、路径穿越、凭证、配置和技能。限制为 256 个文件、单文件 512 KiB、解码后来源总计 8 MiB、单个可选章节 64 KiB、总计 4,096 个标题；HTTP 还受现有 10 MiB JSON 请求体限制。选中上下文快照限制为序列化后 16 MiB JSON；每次整理请求最多包含 8 个章节／64 KiB 来源及 32 KiB 同范围上下文。超限会拒绝，不静默截断。Markdown 解析前限制来源集合最多包含 16,384 个换行及 4,096 个行内语法标记（`* _ ~ [ ] < > !` 及反引号、&、反斜杠），保守计数包含代码块。包含重复祖先正文的展开预览上下文总量限制为 8 MiB；超限时需将来源拆成更小的组。

`POST /preview` 接受来源结构，不保留文件、不启动模型、不创建记忆或任务记录。发送到服务端本身会传输内容；需要浏览器本地预览的宿主应先提供本地文件预览。Qwen 解析器由 CLI 和服务端复用，不作为浏览器库分发。这不意味着外部界面完全不发生网络传输。

版本化预览返回 `digest`、`groups`、`sections` 和 `warnings`。章节包含稳定 `id`、`groupId`、来源 `path`/`line`、带上下文的完整 `content`、`references`、`suggestedScope`、可选 `sourceProject`、`reason` 与 `selectable`。建议范围为 `project`、`user` 或 `unassigned`；建议本身不授权目标。宿主可默认选中所有可选项，但提交待分配项前必须取得范围映射。缺失引用产生警告；未引用的辅助资源被排除。

## 确认、观察与控制

| 方法与后缀                              | 请求                                               | 结果                       |
| --------------------------------------- | -------------------------------------------------- | -------------------------- |
| POST `/batches`                         | `{source, selection:[{id,scope}], idempotencyKey}` | 202 持久化任务             |
| GET `/batches`                          | 无                                                 | 此工作区任务列表           |
| GET `/batches/{id}`                     | 无                                                 | 持久化状态与计数           |
| GET `/batches/{id}/sources/{sectionId}` | 无                                                 | 选中并保留的来源章节       |
| POST `/batches/{id}/cancel`             | 无                                                 | 已取消/终态任务            |
| POST `/batches/{id}/retry`              | 无                                                 | 202 未完成项重新排队的任务 |

`scope` 为 `project` 或 `user`，作用于明确选定的工作区。其他来源项目通过向其他工作区 ID 提交对应章节来映射。不接受目标路径。只保留选中章节并将其发送给模型，辅助章节也必须显式选中。幂等键由 1–128 个字母、数字、下划线或连字符组成。同一键配不同选择会被拒绝；重复相同请求返回原批次。

任务返回 `version:1`、`kind:"task"`、`id`、`status`、创建/更新时间、`items` 与 `result`。状态为 queued、running、completed、partial 或 cancelled。条目区分 pending、added、duplicate、conflict、skipped 与 failed，提供原因及新增原生记忆的引用。结果计数区分来源章节与新增原生文档。已完成任务仍可能包含需调用方处理的冲突。重试只处理 pending/failed，不重新处理冲突或成功项。取消阻止后续发布；已发出的模型请求可能继续完成，但结果会被丢弃。模型响应保存前校验范围；旧版本保存的范围无效条目可在重试时重新生成，不重置用量或更改有效的同批记录。CLI 输出管道的读取方提前退出不会把已完成操作变为错误；可使用幂等键重新获取结果。

HTTP 400 `memory_import_rejected` 表示来源、选择、批次 ID 无效、不支持的旧记忆路径配置，或托管记忆不可用时拒绝受理；404 `memory_import_not_found` 表示批次不存在。当工作区托管记忆不可用时，提交与重试会在计入任务用量之前以该 400 拒绝受理，因此永远无法导入的工作区不会耗尽自己的额度。运行代关闭或进入排空状态返回 503 `workspace_runtime_unavailable` 和 `Retry-After: 1`。意外的存储或服务故障返回 500 `memory_import_failed`，详细原因仅记录在 daemon 日志。排除故障后，提交使用相同幂等键，重试或查询使用相同批次 ID。已有认证、修改授权及信任拒绝规则保持有效。

202 表示任务已持久化接收，不表示发布完成。提交或重试已返回持久化任务后，随后关闭运行时不会丢弃回执及其任务 ID。后台工作仍在发布前检查运行时；工作区恢复可用后，客户端继续查询该任务。读取操作（包括保留来源正文）在响应前再次检查运行时访问权限。

daemon 激活服务时恢复已注册运行时的 queued/running 批次；之后注册的运行时在首次导入任务访问时恢复。恢复失败时，任务端点返回 503 `memory_import_recovery_unavailable` 和 `Retry-After: 1`，不会将停滞任务报告为正在运行。恢复存储访问后重复请求即可重新尝试恢复，保留原服务及其工作进程去重状态；并发请求共享同一次恢复，成功后缓存结果。预览独立于恢复。恢复错误记录在本地日志，HTTP 错误不包含来源内容或存储路径。模型失败需显式重试。重启恢复会等待异常退出工作进程的 120 秒锁租约过期，无需手动删锁。任务锁或范围锁丢失时只中止依赖该锁的工作，检测到丢失后禁止旧持有者继续替换记录或发布文件，不取消无关任务。未知的重试 ID 在创建任务目录前拒绝。来源快照与任务记录属于私有运行状态，位于 Git 仓库和原生记忆扫描范围之外。发布的文档可通过原生搜索、全文、召回和遗忘操作。来源查看限制在所属工作区和保留的选择范围。

## 最小宿主示例

```js
const base = `${daemonUrl}/workspaces/${encodeURIComponent(workspaceId)}/memory/import`;
const preview = await authenticatedJson(`${base}/preview`, {
  method: 'POST',
  body: JSON.stringify(source),
});
// 展示预览，并取得用户明确的选择与目标范围。
const task = await authenticatedJson(`${base}/batches`, {
  method: 'POST',
  body: JSON.stringify({
    source,
    selection,
    idempotencyKey: crypto.randomUUID(),
  }),
});
const status = await authenticatedJson(`${base}/batches/${task.id}`);
```

`authenticatedJson` 是宿主已有的 daemon 请求方法，包含认证和变更请求头。示例不引入第二套凭证流程。通过来源接口获取保留全文，不直接访问文件路径。默认不记录上传内容，也不将其包含在缺陷报告中。

## CLI

`qwen memory import codex --source <folder> --dry-run --json` 完全离线，不加载模型认证、不写记忆。省略 `--source` 时使用 `$CODEX_HOME/memories`，否则回退 `~/.codex/memories`。

授权整理需传入 `--apply --selection <selection.json> --idempotency-key <key>`。选择文件是明确的章节 ID 与范围数组。当前可信本地项目为目标；映射其他项目组时在对应项目运行。使用 Qwen 已配置模型。`--apply` 与 `--dry-run` 互斥。`--retry` 重试同一键的未完成项。CLI 确认导入会等待任务并打印 JSON 结果；冲突、部分失败和取消返回非零退出码。bare/safe 模式支持离线预览，但拒绝确认导入，与原生托管记忆的可用性一致。

## 用量估算与任务预算

预览包含 `estimate` 与 `groups[].estimate`，字段为 `modelCalls`、`sourceTokens`、`maxOutputTokens`、`reservedTokens`、`exceedsBudget`、`limits`。估算覆盖全部可选来源，待映射组仅供预估。`modelCalls` 是上界：一个预览组可能被映射到 `project` 与 `user` 两个范围，估算同时计入这两种范围布局，因此显式选择只会等于或低于该值。离线预览不读取原生记忆、不调用模型；每批预留最多 32 KiB 已有上下文及有界提示词/schema。实际选择、已处理来源和相关已有上下文可能降低预留量；这不是计费报价。

任务公开 `usage.modelCalls`、`usage.reservedTokens` 和 `budget`。上限为 32 次逻辑调用及 512,000 个预留 token 单位，每次含 8,192 个输出 token 额度。调用前持久化预留；失败、重启、取消和重试均不重置。`partial` 结果通过 `items[].reason` 标明预算耗尽或元数据/相关证据超限。耗尽任务的重试不会补充额度；需显式确认更小的新选择，跨任务仍按原始来源去重。缺少预算记录的旧任务模型预算和已记录用量均为零，历史用量未知。

模型上下文包含有界的同 scope 完整元数据索引和相关全文，明确标记仅索引条目。索引或相关证据超过 32 KiB 时在调用模型前失败。原生快照仍检查全部已有内容，包括未发送给模型的正文。供应商内部重试与 token 统计可能不同；逻辑调用/预留量限制不保证实际计费 token 或金额上限。普通记忆及认证策略不变。
