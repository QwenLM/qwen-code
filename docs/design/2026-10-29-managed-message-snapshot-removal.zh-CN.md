# 移除 Managed 持久化对话快照

[English](2026-10-29-managed-message-snapshot-removal.md) | [简体中文](2026-10-29-managed-message-snapshot-removal.zh-CN.md)

## 状态与范围

最初实现基于 PR #15865 的直接消息分页提交 `cf7a0edf37d390a58db00901a397286023ce62f5`，承接已合并的有界历史查询（#15839）。前一阶段见[Managed 实时消息分页](2026-10-29-managed-live-message-pages.zh-CN.md)。当前差异移除持久化公开对话快照；验收仍等待下列检查完成。

在 #15865 以 `89d3aaea62af96849c4b9b7a2bc68e26347a7ac8` 合并、最终 head 为 `ca8970b84b96c6d3cc5f77fc43b577150a0944c8` 后，删表增量已重放到 `main`。依赖中的水位校验和 smoke 夹具修正保持完整。下文检查早于此次基线同步，不能证明最终源码树验收通过；没有重新开启本地 Java 额度。

用户已选择直接读取可变消息、最近消息分页，以及不要求固定正文版本的实时导出。删除 `ma_snapshot` 及其持久化公开消息页副本。保留 canonical journal、私有原生 journal 快照、执行 checkpoint、child launch snapshot、Workspace 授权及 Legacy daemon 行为。

## 现有行为与问题

公开消息查询及 Managed WebShell 默认 transcript/export 路径使用 `ManagedSnapshotStore`。物化器定期将完整消息投影冻结为 manifest 和页面资源，发布 `ma_snapshot` 行，并推进 `ma_event_stream.current_snapshot_id`。签名游标标识该持久化版本。事件重放下界、Session 摘要、资源回收及 CSI 应用清单也依赖这些行。

直接消息分页使选定产品行为不再需要这些副本。仅删除表会留下查询缺失对象的 SQL、后台写入、保留任务及完整性检查。

## 目标行为

### 消息读取与实时导出

所有公开 Managed 消息读取统一使用直接 `ma_message` 分页：公开 Items、最近 Items、默认 transcript 及导出。首请求固定成员范围上界；每页在独立一致 SQL 视图读取当前正文。保留完整 `(first_sequence, item_id)` 排序、方向及 scope 校验、投影版本检查、每次请求的授权，以及现有条目和字节上限。明确适配数字 `after=N`：排除所有 first-sequence 等于 N 的 Item；后续使用完整双键边界，保留跨页的同序号 Item。保留显式 `cursor` 优先及非数字 `after` 作为游标的现有兼容解析。拒绝旧快照游标，不将其重新解释为消息游标。

默认 transcript 从接受 1–1000 的事件 limit 切换为每页 1–100 条消息；省略时仍默认为 100。原有 101–1000 的 limit 请求现在会收到参数错误，应改为向更早 Item 分页。已移除的 `view` 选择参数不再解释；保留现有 JSON 未知属性处理，不新增全局严格反序列化策略。客户端应按新契约省略该参数。

transcript 响应的续接序号为消息投影实际完成的 `covered_sequence`，不能使用公开事件 tail。客户端通过 SSE 接收后续变化。导出在初始成员上界内正向读取，不承诺正文不可变。初始投影落后于已提交事件时，沿用直接分页器明确且可重试的 pending 响应，不静默导出为空或缺失历史。

现有消费者确需时，可以暂时保留名称含 snapshot coverage 的响应字段，但不暗示存在保留版本。必须按响应区分其含义：transcript 使用本页实际 `covered_sequence` 续接 SSE；导出及公开 Item 分页使用首请求固定的 `throughSequence` 成员上界，后续页不得推进。不新增替代表、持久化分页存储或进程内历史缓存。

### 消息物化与事件重放

继续更新 `ma_message`、公开资源引用、`covered_sequence` 和 `projection_version`。删除公开快照构建、刷新阈值、stale 标记及空闲快照刷新扫描。只有 `last_sequence > covered_sequence` 时才存在待完成投影。

直接从 Session 事件流行读取重放覆盖水位。保留单调递增的 replay floor、活动 Turn 保护、私有 CSI 排除，以及现有部署启用策略。floor 不得越过可读取的消息投影水位。重建投影不降低 floor：保留分页器在 `covered_sequence < replay_floor_sequence` 时可重试的 pending 检查，以及 `projection_version` 变化后的游标失效。消息读取后、SSE 订阅前 floor 已推进时，过期重放重新加载默认实时消息路径，不再请求已删除的快照。本次不增加公开事件删除，不压缩 canonical 历史。

### 资源生命周期与 CSI 清单

删除公开 `SNAPSHOT` owner、`managed-snapshot-page` 和 `managed-snapshot-manifest` 资源、快照过期扫描及公开快照退役批次。保留消息正文回收、读租约、恢复保护，以及全部原生 `NATIVE_SNAPSHOT` 所有权与回收。

同步更新 CSI 应用清单声明的 schema、查询、允许的 owner 和资源种类，以及结构和内容校验。继续拒绝未知对象、引用或 scope 越界。删除过时快照分支不能削弱消息正文、journal 资源、原生历史、输出产物或物理所有权检查。

### 共享 schema 与部署

按首发前规则原地修改唯一 canonical V1 baseline。删除 `ma_snapshot`、`ma_event_stream.current_snapshot_id`、`snapshot_stale_since`、`ma_resource` 中的公开快照页元数据，以及对应索引、外键和 CHECK。删除公开 `SNAPSHOT` 资源 owner 枚举值，保留 `NATIVE_SNAPSHOT`。同步显式投影、schema 校验、CSI 声明、旧职责映射及适用测试。已核对的 39 表 baseline 将变为 38 张业务表。

开发库需要重建；本次不提供 V2 迁移、运行库 `DROP TABLE` 或 repair/history 绕过。保留另一会话正在运行的预览及其原数据库。验收要求 Server/Broker/Harness/WebShell 使用匹配版本。

## 受影响组件

| 组件                                                          | 必要改动                                                     |
| ------------------------------------------------------------- | ------------------------------------------------------------ |
| `ManagedAgentStore`、`AgentStateStore`、`ManagedAgentService` | 替换剩余公开快照读取和覆盖水位联接，移除构建与刷新编排。     |
| `ManagedSnapshotStore`、公开快照模型记录                      | 删除过时的持久化快照实现与接口。                             |
| Replay floor 与 SSE 服务                                      | 使用投影覆盖水位，并明确消息重新同步语义。                   |
| 投影回收器与 Session 退役                                     | 移除公开快照回收，保留消息及原生历史保护。                   |
| Canonical schema 与 `managedschema` 契约                      | 一致删除过时表、字段、owner 和索引。                         |
| `WorkspaceCsiApplicationInventory`                            | 删除公开快照清单与校验，不扩大对未知状态的接受范围。         |
| OpenAPI 与 WebShell                                           | 对齐默认实时读取语义、游标拒绝、导出元数据及生成类型。       |
| 测试及现役运维文档                                            | 将固定副本断言替换为实时分页、水位、授权、退役及恢复不变量。 |

## 验证与验收

复用直接消息回归场景：无快照会话、投影滞后、相同 first-sequence、有界双向分页、正文变化、scope 和版本错误，以及持续写入下有限导出。覆盖 replay floor 推进及投影重建前后的重连。在不含 `ma_snapshot` 的 schema 上覆盖 Session 摘要、回收器运行、退役、严格 schema 准入及 CSI 清单。原生 journal 快照发布、读回、恢复和回收保持原有行为。

按适用仓库预算运行受影响 Java 单元/H2、独立 MySQL、API/surface 契约及 WebShell 检查；完整必需 profile 仍是 CI 门禁。仅在测试输入相同时复用上游证据。不得复用另一会话已关闭的 Java 及预览启动额度，也不得通过本次后续工作重置。无法执行的验收明确记录，不能将源码检查当作运行验收。

本地 build、typecheck、bundle 及四个受影响 WebShell 测试文件的 318 项测试通过。最新已收集的单元/H2 报告包含 835 项：834 项通过，一项 API 契约夹具因空 Session 误用要求两条消息的等待 helper 失败。该夹具已改为等待消息查询就绪，但尚未在本地重跑。

独立 MySQL 8.4.11 完成 141 项：140 项通过，包括 Managed API 27 项、原生 journal 快照 22 项、保留产物 24 项及 CSI 清单 66 项。一项 schema 负例夹具仍引用已移除的公开快照 CHECK，已改为修改保留的资源长度 CHECK，尚未重跑。Session schema 组在本地预算截止时中断，专门的消息分页组未开始。临时数据库服务和文件已清理。保留产物的 24 项通过报告早于三项负例夹具加强：新版夹具保持摘要派生资源身份及原始大正文长度一致。这些加强后的夹具未在本地编译和重跑，旧报告不能证明新断言通过。

本次明确的删表请求使用独立的默认 600 秒本地 Java 额度，包含准备及清理，并已在上限内关闭。此前会话额度仍保持关闭，没有复用。最终 API/schema 夹具复验、加强后的 CSI 负例、完整 MySQL 分页及并发、Checkstyle、SpotBugs 和相关完整 CI profile 仍须完成。独立源码审阅还发现生成列表达式的旧规范化分支假定 projection_pending 含 OR；已删除该分支，并新增缺失或漂移表达式的诊断测试。预算关闭后，这项最终校验器改动及其测试未在本地编译和运行。已记录的单元及 MySQL 运行属于部分证据，不能视为完整门禁通过或生产验收。

后续外部 CI run `40915271041` 已编译 `6851d1a8` 的源码树（合成 merge 为 `abe373a3`，tree 摘要相同）。schema 诊断、保留产物、删除回归、直接分页及 API 契约组在该树上通过，但完整运行失败：Checkstyle 发现两条过时 import，5971 项单元阶段因三处旧物理表数断言出现十项失败。本轮审阅修正删除这两条 import，并将这三处计数从 40 改为 39（38 张业务表加 Flyway）；修正后修订的验证仍待完成，没有重新开启本地 Java 额度。

验收要求：生产 SQL 不再引用已删除的表及公开快照字段，不再生成公开快照副本；默认消息读取及实时导出有界；SSE 续接水位安全；严格 schema/CSI 校验一致；私有恢复历史完整。未完成的集成或 CI 证据必须明确保留。

## 决策与边界

不要求固定版本的对话导出。这是有意的兼容语义变化，必须反映在 API 及部署文档中。不删除原始历史，开发工作不修改用户现有数据库。本次是另一会话读取路径变更的后续，不编辑其活动工作树，不把其未完成验证当成本次删除的证据。
