# 工作区产物查询与批量删除

[English](workspace-artifact-library.md) | [简体中文](workspace-artifact-library.zh-CN.md)

## 问题与范围

现有产物库一次读取一个运行中、未加载或已归档会话。重复查询工作区时，
目前需要重新回放每个未加载会话的记录。本次新增工作区全量读取、按会话 ID
批量读取，以及按明确的 `{ sessionId, artifactId }` 列表删除登记。
保留工作区文件与对话历史。本次只扩展 REST，SDK 封装和磁盘索引不在范围内。

## 协议

所有路由均为持久化工作区作用域，要求与既有产物库相同的可信 runtime 和
daemon 鉴权。仅在产物持久化可用时发布 `workspace_artifact_library`。

| 方法 | 路由                                             | 输入                                                                       |
| ---- | ------------------------------------------------ | -------------------------------------------------------------------------- |
| GET  | `/workspaces/:workspace/artifact-library`        | 全部活跃和归档会话，包括尚无 transcript 的已加载会话                       |
| POST | `/workspaces/:workspace/artifact-library/query`  | `{ "sessionIds": ["..."] }`，1–100 个 ID                                   |
| POST | `/workspaces/:workspace/artifact-library/delete` | `{ "artifacts": [{ "sessionId": "...", "artifactId": "..." }] }`，1–100 对 |

查询返回 `v: 1`、`sessions`（既有单会话产物响应）和 `errors`（会话 ID、
对应 HTTP 状态、错误码、错误信息）。全量发现忽略外部项目或不存在的会话；
显式查询返回这些错误。成员失败不能伪装成成功的空结果。重复 ID 或二元组
只处理一次。删除返回 `v: 1` 和 `results`，每个不同二元组对应一个修改结果
或错误。产物 ID 已不存在时成功返回空变更。批次不保证跨会话事务性；
运行中会话的删除逐项报告结果。保留 live 持久化警告，bridge 保留登记时
不能报告已经删除。

输入错误与工作区级失败使用普通 HTTP 错误。删除经过 strict mutation guard。
读写均验证 live 归属，内部对话 runtime 还逐会话验证可访问性。读取持有共享
归档屏障，分组删除持有排他屏障，runtime 活动与 generation 保护覆盖完整操作。
禁止回退到 primary runtime，不加载会话、不取消归档。

## 会话摘要与渐进查询

DAC 需要在产物快照旁获得会话身份，以显示任务名称、恢复归档会话，以及按来源
跳转和过滤任务。为单会话、全量和指定会话查询的 artifact-library envelope 增加
必填 `session` 对象：可选 `displayName`、原始 `createdAt`、`archiveState`
（`active` 或 `archived`）、`sourceType` 和可选 `sourceId`。通用 live
`/session/:id/artifacts` 合同保持不变。

原始创建时间和创建来源复用已有持久化会话列表元数据。live 标题来自当前 bridge，
持久化创建时间和来源存在时优先使用；无 transcript 的 live 会话使用 bridge 元数据。
持久化显示名称依次使用自定义标题、首条提示，与既有目录一致；无名称时省略。
缺失来源类型使用 `default`，开放字符串来源及其配对 ID 原样保留，包括
`resource_inspection`。DAC 可明确过滤该来源，无需枚举任务目录；全量接口不隐式
排除某种来源。

冷会话的摘要与产物 envelope 一起缓存。live 会话仅缓存有界读取的持久化元数据，
不缓存实时产物响应或标题。使用同一个 runtime 条目 Map 和已有内存预算，以不同
条目类型区分 live 元数据和 cold envelope；两者均检查 transcript 和归属指纹。
live/cold 切换会重建条目。仅追加标题记录或移动归档文件也会触发失效，不依赖产物
事件。live 标题与产物每次重新从 bridge 读取，因此恢复旧会话不会改变原始创建时间，
live 改名也不必等待异步持久化完成。

全量 GET 与指定会话 POST 接受 `Accept: text/event-stream`，默认继续返回 JSON。
仅在产物持久化可用时发布 `workspace_artifact_library_stream`，该能力也保证所有
artifact-library 查询包含会话摘要。兼容旧 daemon 的客户端应检查 capability 和
响应 content type，不能假定必然返回 SSE。

| SSE 事件        | 数据及含义                                          |
| --------------- | --------------------------------------------------- |
| `start`         | `v: 1`、候选会话数 `total`                          |
| `session`       | 含摘要的完整单会话产物 envelope                     |
| `session_error` | `v: 1`、`sessionId`、`status`、`code`、`message`    |
| `complete`      | `v: 1`、`total`、`succeeded`、`failed`、`skipped`   |
| `error`         | `v: 1`、`status`、`code`、`message`，请求级致命错误 |

每个请求只发现一次会话，最多四个持续取任务的读取 worker。按完成顺序独立发送每个
结果；慢会话只占自己的槽位，不阻挡其他 worker。JSON 保留选择顺序。全量查询继续
跳过不存在或属于其他项目的持久化会话，指定查询显式报告错误。只有 `complete`
表示扫描完成；终止 `error` 或未收到 `complete` 就断连，均表示部分结果。这是有限
查询，不提供重放、自动重连或实时订阅。POST 通过 fetch 消费 SSE。

读取完成后先释放会话归档屏障，再等待网络背压。写入串行，每个 worker 等待当前结果
写出后再领取下一项，使待发送结果数量受并发数限制。没有待完成写入时才发送心跳。
断连后停止派发和写入，已开始的共享缓存读取仍在屏障内完成，不取消其他请求共用的
加载。整个请求保留 runtime activity/generation 检查。发送 headers 前保留普通
HTTP 错误；发送后用终止 `error` 报告失败，不追加 JSON 错误响应。删除协议及执行
路径保持不变。

## 缓存设计

按 runtime 对象保存有界缓存，避免不同 generation 或存储根共享结果。
已加载会话始终从 bridge 读取产物，并将对应冷缓存替换为有界的持久化身份元数据。
缓存成功的冷会话产物响应，
包括空结果；不保存 transcript 或文件内容。同一个未变化会话的并发加载共享。

既有单会话 artifact-library GET 与全量和批量查询共享此缓存。任意接口预热后，
其他接口均可复用；单项或批量删除都会使共享条目失效。单会话响应仅新增 `session` 摘要，既有字段和错误结构
保持不变。缓存响应的 `generatedAt` 表示该投影的构建时间。

通过两个 transcript 位置及 runtime 归属元数据的 `lstat` 身份验证冷缓存：
设备、inode、mode、size、mtime 和 ctime。读取前后比较身份，仅缓存未变化的投影。
未变化条目没有要求重新回放 transcript 的有效期。外部修改、删除、归档移动
和文件替换会在下一次查询被发现。显式删除前后清理对应条目。每个 runtime
缓存的元数据采用 32 MiB 序列化大小预算。保留已缓存且未变化的条目；新增结果
超出预算时直接返回但不缓存，避免每次全量遍历都淘汰已有条目。这些未缓存会话
在后续查询时仍需回放。条目失效或发现会话已删除时释放缓存空间。

从两个聊天目录枚举候选文件名，不解析全部 transcript。根据目录身份缓存候选
列表，共享并发扫描。即使目录身份相同，扫描完成至少两秒后的首个查询也会重新
枚举，避免低精度时间戳让新冷会话长期不可见。此次刷新只扫描文件名，保留未变化
会话的产物缓存。每个请求最多并发处理四个会话，限制同时进行的 transcript 读取。
使用现有会话读取验证项目归属，避免既有枚举方法静默截断
10,000 个文件的限制。每次请求合并 live ID。全量响应仍需处理与返回元数据数量
成比例的工作；本次不保证常数时间查询或冷产物文件状态的实时准确性。
文件系统身份检查次数仍与会话数量成比例。

## 分组持久化

删除二元组按 session 分组。冷会话组只获取一次现有 writer 或 maintenance lease，
回放一次，追加一条包含所选 tombstone 的产物事件，然后释放 lease。保留当前
分支的父节点、managed authority 拒绝规则、存储校验和共享预览引用清理语义。
既有单产物删除服务方法委托给分组操作。每次请求最多 100 对，低于持久化事件
最多 800 个变更的限制。

## 组件与验证

涉及 CLI 产物 helper/cache、session 路由、能力及遥测注册、core 分组产物删除、
协议文档和针对性测试。既有单会话路由保持合同不变。

验证 live/cold/archived 发现、显式批次、重复与非法输入、混合成员失败、
作用域/信任/generation 保护、冷查询经过较长时间仍只解析一次、并发加载合并、
外部替换与 runtime 元数据失效、空缓存命中、归档及加载/卸载切换、分组删除
持久性/幂等性/警告和工作区文件不变。执行 build、typecheck、bundle 和针对性
测试，在隔离临时 runtime 中验证全局 CLI 基线与本地 bundle。
E2E 计划位于 `.qwen/e2e-tests/workspace-artifact-library.md`。

验收还包括：恢复会话的原始创建时间、live/cold 改名即时可见、归档移动、来源保留和
过滤、跨接口元数据缓存复用、首个会话阻塞时后续快会话先返回、断连清理、背压、
部分失败与唯一完成事件。补充 E2E 计划见 `.qwen/e2e-tests/artifact-library-dac.md`。

## 决策与限制

无待定产品问题：删除只针对明确二元组，不隐式清空产物。内存缓存在同一 daemon
生命周期内优化重复请求，重启需要重建。结果是逐会话快照，不是整个工作区的事务
快照。部分错误始终显式返回。
