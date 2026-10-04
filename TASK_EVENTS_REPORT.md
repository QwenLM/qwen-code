# Task events lane (H3) — 施工报告

分支：`h3-task-events-lane`（基于 `docs/h3-shell-monitor-design` @ `b8a5bff550`，本分支为独立 worktree 施工，不合并 monitor 车道成果）。
范围：把 H0c 标记为 `planned` 的 `listSessionTaskEvents` 与 `queryWebShellTaskEvents` 翻为 `partial`，落地 SQL 任务事件 journal、floor/可见性屏障、output cursor、§6.1 演示逻辑断言与 #12847 C15/C16 缺口，以及 WebShell 类型再生。

## 提交账目

| Commit                                                            | 变更范围                                                                                                                                                                                                                                                                       | 验证集           |
| ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------- |
| `d17163b43d`                                                      | feat(managed-agent): serve the task events routes with their SQL journal（本切片全部：V39 迁移、journal store、revision→state_changed 接线、双表面路由与模型、OpenAPI flips、契约测试探针与 C15/C16 实例、§6.1 journal 契约测试、web-shell 类型再生、H3 设计 status 行双语言） | 见下「测试总账」 |
| 本文件随报告提交加入（SHA 见 `git log h3-task-events-lane` 顶端） | docs: 本报告                                                                                                                                                                                                                                                                   | —                |

## Flyway 取号记录

- 本分支基线最大号：**V34**（`V34__managed_tool_output_collection.sql`）。
- `origin/main` 当前最大号：**V35**（`V35__managed_session_tool_profile.sql`）；V15/V29 为 Java-only 烧号，不填洞。
- 在飞 PR 占用（`gh pr list --files` 核对，当日）：#13336 占 V35（`managed_session_task_event`，H0c outbox）、#13247 占 V35、#13355 占 V36（`managed_task_event`，H0c outbox）、#13354/#13325/#13260 占 V36–V37、#13289 占 V35–V38。
- 结论：取 **V39**（`V39__managed_session_task_journal.sql`），为全部可见来源中第一个无人认领的号；合入时若 main 前进，按 H3 设计条款在 merge 时重编号。在飞两条 H0c outbox PR（#13336/#13355，互相竞争、均未合入）与本 lane 语义互补（它们产任务视图公告 outbox，本 lane 是事件 feed）；为避免命名碰撞，本 lane 新表命名 `qwen_managed_session_task_journal[_cursor]` 而非它们认领的 `..._task_event`。**未发现同区域同号冲突，无需停线。**

## 实现口径（与设计的偏差与取舍，供评审）

1. **state_changed 触发点**：H3 设计文字为「each record revision」；本 lane 按视图变化落事件（`previous == null || projection changed`，与 H0c `task.updated` 公告同点）。理由：Monitor 观测修订以 1s 去抖上量，状态不变的修订会产生同态噪声事件；契约事件种类名即 `state_changed`。如需严格按字面改为每修订一事件，顶层一句之改。
2. **output/artifact 事件生产者**：日志页持久化/Artifact 可见性的生产者接线属于 shell/monitor 车道的 Java 提交路径，本 lane 只提供带完整屏障语义的 store API（`appendOutput`/`markOutputArchived`/`appendArtifact` + 100-ref 与 backlog 边界），由 §6.1 契约流量直接驱动。任务 `read_output` 能力与 output 事件流因此尚未对真实任务开放（projection 侧这是 monitor/shell 共享面）。
3. **retention 驱动**：每次 append 后的自动 pass（保留 256 行，barrier 夹取）+ 显式 `expireThrough`；backlog 上界 512 行，越界即拒绝（生产者背压的失败放大点）。
4. **capabilities.artifacts 准入门**：store 检查持久半部（workspace 绑定且非 DELETING/DELETED）；`artifactReadsEnabled` 配置半部在 ManagedAgentService 的 capabilities 计算处，生产者接线落地时并入（当前无生产者，无悬空开关）。
5. **§6.1「delayed concurrent commits」演示**：以顺序提交模拟（同 Session 的序列分配在 journal head lock 下，真并发写入在本提交路径上不可能越过已返回游标——锁序即证明）；真两事务并发探针属于物理验收面。
6. **真实库覆盖**：§6.1 全部演示跑 H2(MySQL mode) 契约流量；MariaDB/MySQL 的 failsafe IT（设计验收第 7 条 "passes as contract-test traffic on MariaDB and MySQL"）未加新 IT 类，列为欠账，随 H3 物理验收补齐。

## CLI/daemon 流程面结论

核查 `packages/cli/src`（含 `serve/`）：无 `/api/agent/web-shell/v1` 的消费者、无 java-managed 客户端、无 daemon 侧路由白名单/代理表（daemon 仅出静态资产与 CSP；web-shell 经 vite 前缀代理或 Hosted 直连 Java）。因此本 lane 的 CLI/daemon 面变更**为空集**；唯一必要再生为 `packages/web-shell` 的 `managed-agent-api.ts`（已执行，`managed-agent-api.test.ts` 门通过，263 个 managed 组件测试全绿）。任务事件 UI 消费方法留给渲染任务输出的切片。

## 测试总账

| 套件                                                       | 结果                                                       | 环境                                                              |
| ---------------------------------------------------------- | ---------------------------------------------------------- | ----------------------------------------------------------------- |
| `PlannedTaskContractTest`（7 tests）                       | ✅                                                         | JDK21, H2/MySQL mode                                              |
| `ManagedTaskEventJournalTest`（9 tests，§6.1 演示）        | ✅                                                         | 同上                                                              |
| `ManagedAgentApiContractTest`（6 tests，路由/记录/探针门） | ✅                                                         | 同上 + Spring MockMvc                                             |
| `ManagedExtensionRecordStoreTest`（15）                    | ✅                                                         | 同上                                                              |
| `ManagedAgentServerIntegrationTest`（27）                  | ✅                                                         | 同上                                                              |
| managed-agent-server surefire 全量                         | ✅ **565 tests, 0 failures, 1 skipped**（skip 为基线既有） | mvn -o, JAVA_HOME=jdk21, maven 3.9.11, 隔离 m2=/tmp/taskevents-m2 |
| `packages/web-shell managed-agent-api.test.ts`（2）        | ✅                                                         | node, vitest                                                      |
| `packages/web-shell client/components/managed` 全量（263） | ✅                                                         | 同上                                                              |
| `npm run build`（仓库根，TS 全量编译）                     | ✅ exit 0                                                  | node22+, darwin arm64                                             |

环境：macOS (darwin)，JDK `/Users/wenshao/Install/jdk21`，Maven 3.9.11（`-o -Dgpg.skip=true -Dspotbugs.skip=true`），m2 隔离仓 `/tmp/taskevents-m2/repository`（`cp -al` 自 `~/.m2`），runtime-broker 先 `install -DskipTests`（exit 0）。

## 欠账与未决事件

1. output/artifact 事件生产者接线（shell/monitor 车道 Java 提交路径接入 `appendOutput`/`markOutputArchived`），届时任务方可在投影侧广告 `read_output`。
2. §6.1 的 MariaDB/MySQL failsafe IT 覆盖（随 H3 物理验收）。
3. 「每修订一事件」vs「视图变化一事件」的设计字面裁决（本 lane 取后者，见上 1）。
4. `artifactReadsEnabled` 配置半部并入生产者准入门（随生产者接线）。
5. 在飞 H0c outbox PR（#13336/#13355）若先合入 main：本 lane 合入时需核对 outbox/journal 的语义重复（outbox 是视图公告、journal 是事件 feed；设计主张 feed 直接写 journal，outbox 可由它 drain），Flyway 按 merge-time main 重编号。
