# 让 A2A 任务查询在 transcript 读取故障后恢复

## 问题与现状

`GetTask` 遇到瞬时 transcript 读取错误时，已完成的 session-agent run 可能早已写入回复。目前 `jsonl.read` 会把读取失败作为空结果交给 `SessionService`。A2A session port 用 `fs.access(R_OK)` 检查活动路径，即使读取失败，权限检查也可能通过，并且该检查没有覆盖归档 transcript。`observeTask` 因此可能为标记为 `recorded: true` 的已完成 run 保存 `TASK_STATE_FAILED`。后续查询会持续返回已保存的失败。上游 main 的 `02dc72342b` 仍有这一行为，基于会话的 A2A 受 `experimental.agentCollaboration` 控制。

较早的 PR 提议按需传播读取错误。评审指出缺少 JSON-RPC 错误映射和归档路径回归覆盖。另有评审提出了 JSONL 损坏和旧版本已保存错误结果的问题。[Issue #13738](https://github.com/QwenLM/qwen-code/issues/13738)、[PR #13797](https://github.com/QwenLM/qwen-code/pull/13797)。

## 方案

1. 为 `SessionService.loadSession` 和 `loadArchivedSession` 增加可选的 `throwOnNonEnoentError`。沿现有记录读取路径传递并复用 `jsonl.read` 的同名选项。保留现有的读取完整性回调、历史重建、工作区校验和归档大小上限。现有调用方继续使用默认行为。
2. 在默认 A2A session port 的两条读取路径启用选项，并移除 `fs.access`。活动 loader 返回空结果后尝试归档 transcript。任一查询路径的 Node 文件系统异常都转换为 `A2ASessionError('unavailable')`。用 `isNodeError` 和文件系统错误的 `syscall` 区分此类错误、普通异常和带错误码的参数错误。在 transport 记录的异常中保留原始诊断信息。若活动文件存在但不可读取，即使有归档副本也停止观测，因为归档副本可能已经过时。归档文件超出大小限制和预期之外的内部错误沿用原来的处理。活动或归档文件在开始读取时不存在，继续按现有的 `ENOENT` 行为处理。读取成功之后的 `stat` 等文件系统操作如果报错，本次结果观测失败。
3. 在 A2A JSON-RPC 错误边界把 `A2ASessionError('unavailable')` 映射到现有的 `-32012` 响应。调用方看到现有的通用提示，服务端保留诊断信息。`SendMessage`、`GetTask`、`ListTasks`、`CancelTask` 共用这层边界，均可能读取已记录的回复。`ListTasks` 读取任一回复失败时只返回错误，此前已观测的任务可能已经写入结果。现有列表流程在过滤和分页之前观测任务。`SendMessage` 观测结果失败时可能已经派发 run，重发时应使用相同的 `messageId` 和载荷来查询该 run。`CancelTask` 的首次观测出错时可能还未发出取消请求，用于生成回执的观测出错时则可能已经发出。取消和回执的恢复机制独立于此次读取修复，只有成功观测到终态才写入任务结果。

| 观测结果                                                                                                     | 行为                                                         |
| ------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------ |
| 已记录的回复可读取                                                                                           | 返回记录的状态和回复，按现有规则保存终态                     |
| 两次查找均未返回会话数据，包括打开文件或初次归档 `stat` 时遇到普通 `ENOENT`，或已加载的对话中没有匹配的回复  | 沿用 run 状态回退规则，包括对已完成但缺少回复的 run 判定失败 |
| 任一 loader 抛出文件系统异常，例如读取期间的 `EIO`、打开时的 `EMFILE`，或活动文件读完后 `stat` 遇到 `ENOENT` | JSON-RPC 返回 `-32012`。此次失败的观测不写入任务结果         |
| 归档 transcript 超过 64 MiB                                                                                  | 沿用超大 transcript 错误处理。此次失败的观测不写入任务结果   |

## 兼容性与范围

A2A 请求继续绑定到选中且受信任的工作区运行时。沿用 grant 和调用方到任务的映射做授权。Session port 继续使用该运行时的 `workspaceCwd` 和 `sessionRuntimeBaseDir`，不会新增向其他工作区的回退。沿用现有任务状态、数据结构、存储与重试规则。已保存的错误失败与真正缺少回复的失败无法可靠区分，因此不做数据迁移。成功读取文件后继续使用 JSONL 容错解析，回复行损坏时仍可能被解析器跳过。归档与还原流程不属于本次变更范围。例如，还原操作在归档 `stat` 与打开文件之间移动了文件，两次查找都可能遇到 `ENOENT`，沿用现有的缺失处理。权限检查或第二次读取都无法确定原始读取的结果。

服务中的状态 loader 只有活动和归档两个入口。活动 loader 的生产调用方包括 core 配置、服务的分支与最近会话路径、`ChatRecordingService`、`SessionReferenceService`、CLI 启动时的恢复和分支、ACP `acpAgent` 加载、Ink 的恢复、分支和预览、OpenTUI 的会话切换、分支和选择器预览、CLI 斜杠命令导出、daemon 会话导出、提示终态记录、实时任务服务和实时启动上下文、session-agent 历史回退，以及 A2A。归档 loader 用于 daemon 导出和 A2A。只有 A2A 启用文件系统错误传播。

## 验证与验收标准

- 通过真实 Express JSON-RPC transport、默认 A2A 会话 loader 和磁盘任务映射发起 `GetTask`。对可读取的真实活动 transcript 在 Node 文件系统流注入带 `syscall: 'read'` 的异步 `EIO`，归档 transcript 单独验证。故障期间断言返回 `-32012`，并且此前尚未观测的任务仍没有保存结果。清除故障后查询同一个任务，断言返回 `TASK_STATE_COMPLETED` 和原回复，并保存完成结果。
- 将可读取但没有匹配回复、文件缺失作为控制用例。活动路径验证注入故障期间权限检查仍通过。检查没有 `syscall` 的带码参数错误仍返回通用内部错误，归档大小上限仍有效。验证其他进入同一失败观测路径的 A2A 方法返回相同的通用不可用响应。
- 运行 CLI 的 A2A 定向测试、core 的 SessionService、JSONL 和 A2A 测试，再执行构建和类型检查。记录测试环境与验证缺口。

## 设计审计

1. 正向审计追踪了服务调用方和选中运行时的边界。反向审计发现了陈旧归档副本回退、还原竞态以及列表和取消操作的部分副作用。设计补充了这些边界，并区分文件系统错误与内部错误。
2. 正向审计确认了端到端覆盖和双语一致性。反向审计区分了普通路径查询的 `ENOENT` 与读取后 `stat` 的错误，并将不写入的保证限定在失败的观测。Node 探针也验证了异步 `EIO` 即使在读出部分内容后仍会让读取拒绝。
3. 正向审计确认两条加载路径和四种任务方法均进入拟定的错误处理。反向审计用 `EMFILE`、普通 `ENOENT` 和归档超出上限异常验证了分类。没有剩余阻塞项。

## 验证结果

在 macOS 27.0 arm64 上，本地 daemon 探针使用真实的磁盘 transcript、默认 session port 和 JSON-RPC。活动和归档用例均在 `access(R_OK)` 继续通过时注入异步 `EIO`，得到下表结果。

| 观测                       | 已安装的 Qwen Code 0.27.3              | 包含修复的 CLI 构建                        |
| -------------------------- | -------------------------------------- | ------------------------------------------ |
| `EIO` 期间第一次 `GetTask` | 返回并保存 `TASK_STATE_FAILED`         | 返回 JSON-RPC `-32012`，未保存结果         |
| 读取恢复后的 `GetTask`     | 返回同一个已保存的 `TASK_STATE_FAILED` | 返回并保存 `TASK_STATE_COMPLETED` 和原回复 |

正常 transcript 在两次运行中均返回回复。文件缺失和可读取但回复属于其他 run 的 transcript 在两次运行中均返回预期的缺少回复失败。修复后的 bundle 使用 Node 22.18.0。CLI 和 core 定向测试分别通过 22 项和 391 项。`npm run build`、`npm run bundle`、`npm run typecheck`、定向 ESLint 和 Prettier 检查均通过。Linux 和 Windows 未测试。
