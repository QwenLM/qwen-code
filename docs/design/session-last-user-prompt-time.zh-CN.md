# 会话摘要中的最近用户发问时间

[English](session-last-user-prompt-time.md) | [简体中文](session-last-user-prompt-time.zh-CN.md)

状态：已实现并通过本地验证。隔离环境下依赖凭证的已加载会话 E2E 仍被阻塞；status 路由专项测试通过。
目标基线：`2cba716faf2b8ca807e3d89ab82e605c5247e1a8`。

## 问题与当前行为

会话客户端需要最近一次真实用户问题的时间，以显示距今多久。`createdAt` 是会话创建时间。`updatedAt` 合并持久化文件 mtime 与 live turn 结束活动，助手输出、元数据写入和后台执行都可能推进它。两者都不是所需事实。

当前持久化列表仅读取前十条记录及有限元数据窗口。批量 catalog 的全量扫描遍历的是会话文件，并不完整遍历每个文件中的所有消息。`SessionTranscriptReader` 已有冻结快照的完整遍历与有效主转录重建，包括 Managed 已提交记录投影。复用这些语义可以避免另写一套转录解析器。

## 目标与范围边界

在 native 会话摘要及 SDK 类型中增加可选 `lastUserPromptAt: string`。合法的 ISO 日历时间统一转换为 UTC 毫秒格式（`YYYY-MM-DDTHH:mm:ss.sssZ`）。仅在能从符合条件的持久化用户记录得到时间时返回；缺失表示未知或没有符合条件的问题，绝不表示创建时间或当前时间。

本功能不改变会话排序、分页、来源过滤、分组、`updatedAt`、live-state 轮询、prompt 执行或 UI 格式化。不新增公开端点、capability、配置项或问题正文 payload。相对时间的具体格式及本地化由客户端负责。

## 真值规则

真值是会话有效主转录中，按转录顺序最后一条符合条件记录的 `ChatRecord.timestamp`。合法时间归一化为 ISO；无效时间跳过，不使用其它时钟替代。保留记录的时间，包括时钟偏移产生的未来值；显示端自行决定是否钳制。

符合条件的是主会话的 `type: user` 记录，provenance 不是非用户来源，且 subtype 为空、`mid_turn_user_message`、`realtime_message` 或 `agent_mention`。包括纯附件问题、真实语音输入和人工向 agent 提出的问题；外部 agent 发送的 `agent_mention` 仍因 `external_agent` provenance 被排除。不以文字是否可见为门槛。旧记录没有 provenance 时，若其余形状符合仍可计入。

纳入已持久化的 `mid_turn_user_message`：它是从宿主队列取出的真实人工输入，在注入时仅记录一次，不是合成的重复用户轮次。该 subtype 为 API history 重建服务，不能据此排除用户问题。单独的 `backgroundTurn` 上下文属性也不能说明作者是自动程序，因为真实人工追加可能在后台执行期间被记录。

排除 notification、cron、Goal runtime/control、工具结果、助手/系统记录、含 `agentId` 或 `isSidechain` 的记录、继承的 `forkedFrom` 历史，以及有效活动分支之外的记录。子会话记录不能推进父会话时间；不能仅因行带 `parentSessionId` 就拒绝整个子会话。根据记录判断来源，不根据行的来源类别猜测。规范 reader 在未选择隐藏继承历史时会保留继承记录，因此时间投影必须显式忽略 `forkedFrom`，不能假定每条 replay 记录都是本会话新发问。

retry、continue、恢复 ask-user-question，以及被拒绝或取消且从未产生合格记录的排队 prompt，都不推进字段。这是已记录问题的时间，不是排队接收或模型完成时间。Managed 未提交事件不计入，复用既有 Managed 投影。

## 分层实现方案

### Core 转录元数据

在转录 reader 附近增加一个共用的合格记录判定与时间投影。规范索引项仅保留选择最终有效记录所需的候选时间。复用活动分支、继承历史、sidechain 与 Managed 投影规则。不能直接复用目前 turn-state 的纯文字判定或导航标签判定，它们的纳入规则不同。

通过 `SessionService` 与 `SessionTranscriptReader` 暴露 `getLastUserPromptAt(sessionId, archiveState)`。Service 通过 `readProjectSessionHead` 仅读首条记录预检持久化归属，不扫描标题/来源元数据；reader 复用规范冻结索引及其 single-flight 缓存。标量缓存同时保留实际索引首条记录的 session ID 与 cwd，每个调用都在共享 promise 之外校验这两个归属标量，包括缓存命中。预检后路径被替换时，授权仍绑定时间所属的实际快照；不保留消息正文，也不重新完整扫描未变化快照。列表不调用 `loadSession` 或 `readRestoreProjection`。

### 历史回填与缓存

旧文件没有权威的最后问题 sidecar，因此冷读取无法完全避免。仅在过滤、排序、分页之后补齐最终返回页；不能为了不参与排序的字段，把最多 50,000 个 catalog 成员逐一完整读取。

复用规范冻结索引 reader 及其 single-flight 行为。增加简单有界标量 LRU，键为规范 runtime/文件路径及快照指纹（文件身份、大小、mtime），只存可选时间和首记录归属标量，不存正文。稠密 reader 缓存仅 32 项，此举避免 100 行页面反复淘汰完整索引。指纹未变化则命中；文件替换、截断、mtime 或 size 变化则失效。不持久化此缓存，不增加 sidecar、写入 schema 或独立 JSONL 解析器。

选中页的冷数据行可能需要一次规范冻结快照遍历；明确承认该历史回填成本。每页最多并发两次元数据读取，同一指纹复用进行中的读取。对于指纹未变化的重复列表/status，即使稠密索引已被淘汰，也不能再次完整扫描。文件变化可经既有权威 reader 重建；后缀增量索引及 writer 优化不是本功能必做项。测量较大持续变化文件与热页；若实测开销不合理，回报具体成本评估，不能静默改用活动时间。

元数据 reader 在构建索引前检查文件大小。超过规范 256 MiB 索引上限的转录不提供时间元数据：不完整扫描、不警告、不重试，也不因这一行使整页失败。该安全省略不表示历史中没有用户输入。其余 I/O 错误仍沿用既有失败合同。

元数据读取冻结已观察的前缀，并允许同一文件身份下大小增长，因此并发追加助手输出不会使页面失败。文件替换、截断，或同大小改写且 mtime 变化会拒绝快照。此项元数据专用容差不改变 restore 默认使用的严格快照签名。取消后，本调用方不再开始后续页面行；已经共享的扫描可继续为其它等待者完成。

不补齐未返回行，不改变前十条记录的列表读取。保持既有 reader 的大小/快照/Managed 校验及取消边界；取消后不再开始下一行。标量缓存使用小型内部条数上限，不增加公开配置。初版可用 512 条，验证它可保留 100 行页面且不会无界增长。

### Daemon 摘要、catalog 与 status

该时间属于 persisted-workspace 元数据。将字段加入 `BridgeSessionSummary` 与 `DaemonSessionSummary`。在已解析工作目录 runtime 内补齐选中响应行，使用该 runtime 的输出目录、archive state 和规范 cwd。批量 catalog 复用单目录 producer。未知、移除、不可信或不可用 runtime 的既有行为不变；不能回落 primary，也不能因浏览启动 ACP 子进程。

合并 live 摘要时保留持久化值；live 不含字段时不能擦掉它。live 会话的首个真实问题进入转录后即可显示该持久化时间；合格持久化记录出现前保持缺失。bridge prompt echo、running/terminal 事件使用其它时钟，不能填此字段。status 使用同一元数据 owner 补齐；memory-only live-state 仍保持只读内存。

### SDK 与其它消费者

SDK list、catalog、standalone-summary、status 原样保留可选时间戳。同步两个公开线格式类型镜像及相关 API 文档。检查每个 `BridgeSessionSummary`、`SessionListItem` 的构建与消费处。该字段属于 daemon 摘要元数据。native CLI JSON list、人类可读 CLI 列、`SessionListItem` 和各客户端 UI 不变。Core 会话统计/只计数路径不触发元数据回填。

## 预期文件

- `packages/core/src/services/session-transcript-reader.ts` 及定向测试：有效记录投影、Managed 兼容、缓存摘要读取。
- 仅在确有需要时增加相邻小型元数据 helper，隔离共用判定/缓存；不建设通用存储框架。
- `packages/core/src/services/sessionService.ts` 及定向测试：校验归属的元数据 accessor；不改变 `SessionListItem`。
- `packages/cli/src/serve/server/session-list.ts` 及测试：最终页补齐、live 合并、归档 owner、缓存/读取边界。
- `packages/cli/src/serve/routes/session.ts` 与 `session-catalog.ts` 测试：既有 runtime owner 下的 status、batch 行为。
- `packages/acp-bridge/src/bridgeTypes.ts`、`packages/sdk-typescript/src/daemon/types.ts`、相关 SDK 测试及协议文档：新增可选线字段。

## 验证与验收

先使用全球安装的 `qwen`，合成历史、隔离 HOME/runtime/workspace，并只监听 loopback；持久化 catalog 覆盖无需模型请求。再以本地构建 CLI 执行同一计划。基线缺少字段属于预期缺口，不能把它记成功能断言通过。

覆盖普通多轮问题、助手/元数据更新、语音及纯附件、注入/后台/cron/Goal、sidechain 和 fork、retry/continue/cancel、Managed 已提交与未提交、无效/缺失时间、live/persisted 合并、归档还原、替换/截断/rewind、并发读取、缓存命中/失效、多 workspace 隔离和最终页读取边界。时间与 fixture 记录比较，不能与 mtime 比较。运行 build、typecheck、bundle、定向 package 测试，再做自审及 review。

成功条件包括排序/游标不变、不增加逐卡网络请求、只读浏览不创建或执行 session，以及标量缓存保留的未变化快照不额外完整扫描，包括超过稠密索引缓存容量的页面。未知值保持缺失。E2E 计划分别记录基线、本地验证和阻塞项。

本地验证已完成 `npm run build`、`npm run typecheck` 和 `npm run bundle`，review 修复后重新构建了受影响的 core package。定向测试通过：core 427 项、列表/catalog 70 项、status 路由 6 项、SDK 8 项。status 测试单独运行并关闭 coverage，以避免并发写入 coverage 产物冲突。

本地构建 CLI 通过 49 项隔离合成 E2E 断言，覆盖普通与排除记录、无效时间、人工 agent mention、重复读取、助手/用户追加、重启、多归属和超限历史。4 次 native CLI NDJSON 读取保留既有输出合同。16 个应省略字段的响应对象均不含该键，而非返回 `null`。加载 live 会话需要凭证，因此该项 E2E status 仍被阻塞；仅持久化会话的 status 保持 `404`，status 补齐由专项路由测试覆盖。未发送模型 prompt，也未使用真实凭证。隔离 daemon 关闭时仍可能出现基线已有的 preheat 关闭错误；所有测试监听端口均已关闭。

## 实测成本与边界

以下为本地合成转录与元数据 getter 的单次测量，不是生产延迟承诺。较大 fixture 为 8,389,847 字节。文件变化时每次重建一个规范索引；助手追加不推进用户时间，真实用户追加会推进。

| 读取场景             |      耗时 | 索引构建数 |
| -------------------- | --------: | ---------: |
| 较大文件，冷读       |  31.68 ms |          1 |
| 较大文件，未变化     |   0.14 ms |          0 |
| 较大文件，助手追加后 |  17.98 ms |          1 |
| 较大文件，用户追加后 |  32.19 ms |          1 |
| 100 行页面，冷读     | 127.31 ms |        100 |
| 100 行页面，未变化   |   4.71 ms |          0 |

上述字段合同、纳入已持久化人工 mid-turn、仅最终页补齐和最多两次并发读取已实现。热读仍有有限的归属与文件 stat 检查，但不再次完整扫描。本次不增加 HTTP 请求、轮询、自动重试、定时器或后台任务。新的写入 schema、持久元数据 sidecar 和增量 reader 框架仍不属于本功能。本地验证不表示已部署，也不能证明生产性能。
