# 外部记忆导入

[English](external-memory-import.md) | [简体中文](external-memory-import.zh-CN.md)

## 状态与目标

2026-10-22：首个增量 PR 实现内存中的 Codex 来源校验、上下文预览、分组、引用和保守用量估算。CLI 命令、文件系统收集、模型、持久化和 HTTP 属于后续工作。PR #14281 继续作为完整实现路径保持开放，任何一条路径都不会自动关闭另一条。每个增量 PR 的代码和测试新增与删除行数之和必须不超过 1,000；文档单独统计，不计入该上限。

客户端需要将选中的 Codex 知识迁移到 Qwen 原生记忆，同时避免向云端运行时暴露笔记本文件系统。逐条转换列表会丢失上下文，也无法协调历史知识与已有记忆。解析器和最终导入服务由 Qwen 自身负责；外部产品 UI、独立收集器、持续/跨实例同步和生产部署不在此设计范围内。

## 来源与预览契约

输入为 `{version:1,source:"codex",files:[{path,content}]}`，包含相对路径和 UTF-8 Markdown 内容。仅允许 `MEMORY.md`、`memory_summary.md` 以及被引用的 `rollout_summaries/[A-Za-z0-9_.-]+.md`。至少需要一个根记忆文件；拒绝绝对路径、路径穿越、反斜杠、控制字符、包含 NUL 的内容以及忽略大小写后的重复路径。排除原始会话、凭据、配置和技能。路径仅记录来源，不授权任何目标。后续本地读取器必须拒绝符号链接文件/目录；本解析器接收内容，不访问文件系统。

`previewSource` 返回 `{version:1,kind:"preview",digest,groups,sections,warnings,estimate}`。每个章节包含稳定的 `id`、`groupId`、`title`、`path`、从一开始的 `line`、带上下文的 `content`、`references`、`suggestedScope`、可选 `sourceProject`、`reason` 和 `selectable`。分组包含 `id`、`scope`、可选 `sourceProject`、`sectionIds` 和 `estimate`。ID 对路径和上下文内容计算哈希；来源摘要对校验后按路径排序的信封计算哈希。重排来源文件不改变摘要和 ID；重排章节保留 ID，但可能改变信封摘要。预览不包含时间戳或随机生成的标识符。

保留完整任务章节及祖先标题/前言，不混入兄弟项目。唯一的绝对项目标题或 `cwd` 提示建议为 `project`；摘要中明确的 User profile/User preferences 章节建议为 `user`；缺失、冲突或不支持的提示保持 `unassigned`。建议不授权目标范围。从根资源发现提炼 Markdown 的支持引用，缺失引用给出警告，排除未被引用的支持文件。支持章节在后续仍需单独明确选择，引用不代表传递选择。预览不调用模型、不认证、不读取原生记忆，也不写任务/记忆。服务端预览会传输所提交的内容，不保证浏览器本地隐私。

最多接收 256 个文件、每文件 512 KiB、来源合计 8 MiB。Markdown 解析限制为 4,096 个标题、16,384 个换行和 4,096 个行内标记，保守计入代码块，并尽可能在解析前拒绝病态输入。展开后的上下文内容不超过 8 MiB。超过 64 KiB 的章节保持可见但不可选，并提示拆分来源。无效输入抛出 `MemoryImportRequestError`，不能静默截断。保留 LF/CRLF/CR-only 来源内容，并正确标注行号。

## 估算与后续模型执行

共享预算为每批八个章节 / 64 KiB 来源、32 KiB 既有上下文、32 KiB 提示/schema 额度、每次请求 8,192 输出 tokens、每任务 32 次逻辑调用和 512,000 个预留 token 单位。按来源 ID 确定性排序，并在来源项目组内打包。后续执行还按已确认的范围分组；预览取未拆分批次数的两倍，为一个组可能拆成 user/project 两种范围提供上界。`estimate` 在组级和总量级返回 `basis:"source-only-with-context-reserve"`、`modelCalls`、`sourceTokens`、`maxOutputTokens`、`reservedTokens`、`exceedsBudget` 和 `limits`，只计入可选章节。空选择的估算用量为零。

来源 tokens 使用现有文本估算器；按序列化来源字节、最大既有上下文和提示额度、输出额度及信封开销保守预留。估算不读取原生记忆、不调用服务商，也不是账单报价。实际选择、上下文和去重可能减少用量。后续执行必须在调用前拒绝过大的元数据/相关证据，在分派前持久化预留请求/提示/schema/输出用量，并限制输出和无人值守重试。失败、取消、重启和显式重试不能退回或重置额度；历史用量缺失不授予新预算。

后续模型通过无工具的结构化 side query 使用目标工作区的 Config/认证。历史来源和已有记忆均是不可信数据。只提供已选章节、有界同范围元数据索引及完整相关证据，不能悄悄把过大的相关正文降级。校验精确响应 ID、`new|duplicate|conflict|skip` 决策、原生文档格式及请求范围。已有记忆优先，不确定的重叠判为冲突，绝不构成覆盖许可。只允许发布经过校验的新记录。

## 持久导入与原生记忆契约

提交需要明确的 `{id,scope:"project"|"user"}` 选择，以及长度为 1–128、满足 `[A-Za-z0-9_-]` 的幂等键。服务端从可信目标工作区推导路径，不接受目标路径。仅保留已选、不可变的上下文快照，序列化后最多 16 MiB，放在 Git 和原生扫描之外的私有 runtime 状态中。重复相同 key/请求返回原任务，改变其选择则拒绝。新 key 也不能重复已有来源/输出身份，或恢复已编辑/遗忘的结果。不迁移 #14149 实验状态。

任务使用 `version:1,kind:"task"`，返回 `id,status,createdAt,updatedAt,items,result,usage,budget`。`usage` 包含 `modelCalls,reservedTokens`，`budget` 包含 `maxCalls,maxReservedTokens`，`result` 包含 `sourceSections,newDocuments,duplicateSections,conflictSections,failedSections`。任务状态为 `queued|running|completed|partial|cancelled`；条目状态为 `pending|added|duplicate|conflict|skipped|failed`，并在适用时包含原因和原生引用。结果计数区分来源章节和新发布文档。重试只处理 pending/failed 条目，不处理成功/冲突条目。模型失败需要显式重试。取消阻止新的分派/发布，已开始的请求可以完成但不能发布。独立于 worker 租约和范围锁的短时、按任务划分的 lifecycle gate 为持久化取消、预留/分派和最终取消检查/rename 排序，不跨模型等待持有。等待范围锁期间被取消的 worker 在锁释放后必须消耗零模型预算。

在发布任何成员前，记录完整的已校验批次提案和基线哈希。按目标范围串行发布，并重新校验完整原生快照。发布流程为 stage → intent → rename → committed 台账。恢复等待崩溃 worker 的 120 秒租约过期，复用已保存提案并校验同范围已提交输出，包括其他批次的输出，不能接受外部编辑。确实未发布的 intent 可以重新处理；已 rename 的文档即使没有 committed 回执也受到保护。绝不恢复已编辑/遗忘的输出，也不重复发布。丢锁阻断依赖它的写入，其他任务继续。

项目导入使用按真实 Git common directory 标识的独立私有根目录：主检出与已注册 linked worktree 共享，独立 clone 不共享。普通项目隔离和 `QWEN_CODE_MEMORY_PROJECT_SCOPE` 保持不变，明确说明导入层按仓库共享。身份缓存根据文件系统依赖失效，写入时刷新；没有导入层时跳过 Git 发现。接入原生 search/fetch/recall/forget 及元数据迁移。原生用户条目保留目录优先级和既有限制，导入条目填充剩余容量，超出有界索引时仍可搜索。来源快照不会变成原生文档，也不会授权原生写入器访问来源。发布文档使用原生格式，不增加额外来源标记。

## 后续 CLI 与 HTTP 契约

CLI 预览为 `memory import codex --source <folder> --dry-run --json`，默认使用 `$CODEX_HOME/memories` 或 `~/.codex/memories`。预览保持离线，包括 bare/safe 模式。本地确认导入增加 `--apply --selection <json> --idempotency-key <key>` 和可选 `--retry`，apply/dry-run 互斥。在确认接收任务前拒绝不可用的 managed memory/bare/safe。使用当前可信本地工作区的模型，等待持久化结果，完整刷新 JSON 并容忍 EPIPE。partial/conflicting/cancelled 结果以非零状态退出。

只有 `/workspaces/{workspaceId}/memory/import` 下完整路由齐备才声明 `memory_import_v1`：POST `/preview`、POST/GET `/batches`、GET `/batches/{id}`、GET `/batches/{id}/sources/{sectionId}`、POST `/batches/{id}/cancel` 和 POST `/batches/{id}/retry`。预览接收来源信封，提交接收 `{source,selection,idempotencyKey}`，提交/重试返回持久化 202 回执。所有路由属于 selected-runtime，沿用既有认证/信任检查并设置 `no-store`，变更采用严格授权。保留既有 10 MiB JSON 请求体限制。未知/不可信/已移除/draining/SSH runtime 及旧式 `QWEN_CODE_MEMORY_BASE_DIR` / `QWEN_CODE_MEMORY_LOCAL` 覆盖均拒绝，不回退 primary。

使用所选 runtime 的环境、存储、记忆范围和 bridge，包括无 session 的冷 ACP 分派。在 submit/retry 接收任务和计费用量前检查 managed-memory 可用性。runtime 服务协调单次恢复尝试，失败后由后续任务请求重试，注册的 runtime 在激活时恢复；预览不恢复任务。读取在返回私有内容前重新检查 runtime 访问权。持久化接收后即使 generation 关闭，也保留成功的 202 回执。无效请求返回 400 `memory_import_rejected`、任务缺失返回 404 `memory_import_not_found`、意外服务/存储失败返回 500 `memory_import_failed`、generation/恢复不可用返回 503 `workspace_runtime_unavailable` / `memory_import_recovery_unavailable` 并带 `Retry-After: 1`。HTTP 错误响应不得包含来源正文或存储路径。

## 依赖与验收

每行均包含对应测试和同步设计变更。内部模块不依赖桩实现或功能开关即可构建；完整保障链齐备后才开放写入入口。依赖组成实施 DAG，先合入前置 PR，并按每个 PR 的实际目标重新计数。如果原 PR 先合入，应先协调重叠工作再继续，避免重复实现其行为。

| PR  | 职责                      | 依赖    | 合入前验收                                                                    |
| --- | ------------------------- | ------- | ----------------------------------------------------------------------------- |
| 1   | 本契约、来源预览和估算    | 无      | 合成解析/接收边界/引用/身份/估算测试；无模型、文件系统或公开入口              |
| 2   | 本地来源收集和离线 CLI    | 1       | 白名单/符号链接安全收集；纯 JSON；无认证/网络/任务写入；bare/safe 预览        |
| 3   | 原生导入记忆层            | 1       | Worktree 共享、clone 隔离、身份失效、无导入快速路径、原生读取/遗忘/索引回归   |
| 4   | 模型/上下文提案           | 1       | 不可信/无工具输入、范围/schema 校验、CJK/长来源相关性、有界证据和重试         |
| 5   | 私有状态和登记            | 1       | 只保留已选来源、幂等、有界/符号链接安全状态、worker 租约和短时 lifecycle gate |
| 6   | 发布事务                  | 3, 4, 5 | 去重、编辑/遗忘保护、并发发布、崩溃点、最终检查/rename 的取消顺序             |
| 7   | 提案日志和预算预留        | 4, 5, 6 | 12 个来源按 [8,4] 调用、预算持久化、跨批次恢复、已保存提案复用、精确响应覆盖  |
| 8   | 执行器和本地 apply/retry  | 2, 6, 7 | 真实 CLI/原生记忆链路、排队/在途取消、取消后零新增预留、重试和 SIGKILL 恢复   |
| 9   | Selected-runtime/ACP 适配 | 3, 4, 8 | 次/冷工作区模型与存储、不回退 primary、可用性及可重试的共享恢复               |
| 10  | HTTP/能力接入             | 9       | 完整认证路由契约、隐私、错误/202 语义、真实 daemon → ACP → 模型验证           |

仅使用合成 HOME/runtime/source/repository 和确定性 loopback 模型。执行 build、typecheck，并从受影响包目录运行定向测试；用户可见阶段还需基线和成品探针。完整 diff 通过两次无新问题的自审和独立评审。PR 1 的内部模块脚本不能证明 CLI/HTTP 命令已经可用。生产模型语义质量和 Windows/Linux 恢复属于后续验证。本首个 PR 不使用实际用户记忆或生产服务商。
