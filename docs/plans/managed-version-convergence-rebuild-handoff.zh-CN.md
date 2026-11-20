# Managed Agent 版本收敛 — 重建续作计划

英文版：[managed-version-convergence-rebuild-handoff.md](managed-version-convergence-rebuild-handoff.md)

`packages/managed-agent-server` 投产前版本兼容拆除（「A 批」）的自包含续作计划。
新会话仅凭本文档即可开工，无需任何历史转录。

## 1. 在哪干活

- **Worktree：** `/Users/jinye.djy/Projects/qwen-code/.qwen/worktrees/version-convergence-rebuild`
- **分支：** `feat/managed-version-convergence-rebuild`
- **基线：** `origin/main` @ `1de5c0b34b9`（最新，已含 CSI 冷归档）。
- **在本 worktree 目录新开会话**（**不要** `--resume` 旧的大上下文会话）。记忆与分支状态都在磁盘上。

### 分支别混

| 分支                                       | 位置                                 | 状态                                                                                                                                           |
| ------------------------------------------ | ------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `feat/managed-version-convergence-rebuild` | 本 worktree                          | **活跃**，已验证全绿                                                                                                                           |
| `feat/managed-version-convergence-a`       | 主 checkout                          | **作废**（落后 main 296 提交、早于 CSI 归档）。代码已被取代；设计文档已迁到本分支。须等主 checkout 切走、且并行 B 会话的未提交改动保住后再删。 |
| `worktree-d1-profile-rollout`              | `.qwen/worktrees/d1-profile-rollout` | 另一摊 **D1（B 类）** 活，与本 A 批无关                                                                                                        |

## 2. 先读

1. 本计划。
2. `docs/design/2026-11-19-managed-agent-version-convergence.md`（+ `.zh-CN.md`）
   —— 收敛设计 canonical（已在本分支）。**仍描述已归档的 CSI 机制；需做 §6.1 修订。**
3. `packages/managed-agent-server/AGENTS.md` —— Java 验证策略（10 分钟本地预算、聚焦测试、MySQL/CI 门）。
4. 根 `AGENTS.md` —— 简洁优先、双语设计文档、自审。

## 3. 已锁定决策

- 服务**未投产**：纯滚动升级兼容（A 类）可拆；不需要版本协商。
- **legacy 执行 regime 冻结** —— 只动 managed-agent 路径。
- **CSI 冷归档 #17415**（`0c2458a3ca0`，2026-11-16，已上 main）把 K8s Runtime /
  Resident Workspace / Workspace CSI / Harness Pool discovery 移进
  `packages/sdk-java/managed-kubernetes-archive/`，并从 live server 删除 CSI-only
  schema/配置/端点/维护入口。后果：**A4 整体丢弃**；A1/A2 的 CSI 部分
  （`CsiFilesRetirementProfile.supportsStorage` 围栏、`CsiNativeActivationProof`、
  `WorkspaceCsiRuntimeMain`/`WorkspaceCsiWorkerAckMain`）随归档消失。
- A/B/C 分类：A=纯滚动升级兼容（可拆）；B=双活 regime 选择器（产品决策，冻结，独立设计文档）；C=单版本完整性门（保留）。

## 4. 当前状态与提交链

分支提交（基线 `1de5c0b34b9`）：

| SHA           | 内容                                                        |
| ------------- | ----------------------------------------------------------- |
| `07dcb1ae782` | A2 — 删服务器侧 `minimumReader` 协商                        |
| `3f6d762b11d` | A5 — hosted action options 统一为单一形状                   |
| `71209ac6a39` | A1 阶段1 — 剥离 Session storage-version 协商（非 CSI 核心） |
| `ccd977bcf33` | 设计文档（迁移原本；CSI 修订待做）                          |
| `1cd82710281` | 设计文档 A5 实施 note                                       |

**本基线上已验证全绿（2026-11-19）：**

- Java `test-compile` 净；`ManagedSessionStoreIntegrationTest` 16、
  `ManagedSessionStoreWiringTest` 13、`ManagedSideQueryStoreTest` 9、
  `ManagedActionsTest` 50 —— BUILD SUCCESS。
- Core `tsc --noEmit` 净；`http-managed-session-store.test.ts` 243。
- CLI `src/serve/hosted-tool-approval.test.ts`（A5 parser）14。

此前两次 Java 红均为环境问题（漏 `-am`；live-TS 测试在 dist 构建前跑），非回归。

## 5. 关键结构事实（依赖前先对当前代码核实）

- **A1 `storage_version` 身兼四职：** ① reader 围栏（HTTP 头
  `X-Qwen-Managed-Max-Readable-Storage-Version`、`StorageReadPolicy` /
  `ManagedSessionReaderVersion` / `ManagedStorageVersions`）—— **已删**；
  ② writer-grant 协商（`WriterGrant.supportedStorageVersion`、`supportedStorage()`）
  —— **已删**；③ CSI profile 围栏 —— **已归档**；④ activity 重建标记
  （`JournalCommit` `storageVersion()>=4`、`rebuildActivityBatch`）—— **保留**。
  `storage_version` 列、`storageFloor()`、`needsVersionTwo` → `/transactions:commit-v2`
  路由**保留**（功能性，非兼容）。
- **A2：** authority 停写 `minimumReader`；共享 parser `managed-session-records.ts`
  改可选（present 仍校验以保本地 standalone `/2`）；Java genesis/history 闭集 7→6。
- **A5：** action-options v1/v2/v3 → 单一 v3（`inputRef`/`continuationRef` 可选）+ v4 question；
  按字段存在性校验；continuation 守卫按 `continuationRef` 存在性；`storageFloor` 按
  `continuationRef` 存在性提升。
- 重建冲突解决原则：**取 main 结构 + 去 `readerVersion`**；归档 CSI 文件自动解析为删除。

## 6. 下一步（排序）

### 6.1 设计文档 CSI 归档修订（先做；双语）

更新 `docs/design/2026-11-19-managed-agent-version-convergence.md` **与** `.zh-CN.md`
反映 #17415。两语须完整同步（根 AGENTS.md 设计文档规则）。受影响 EN 位置（行号近似，编辑前重 grep）：

- 标题（1 行）与 Problem（10–11）：从范围去掉 "CSI handles" / A4。
- A1 ② writer-grant（58–67）：删 `supportedStorage` 的 CSI-profile 派生。
- A1 ③ "CSI profile capability fence"（74–80）：标注 moot/已归档。
- A2（149）：`CsiNativeActivationProof` 引用 —— 已归档。
- **A4 节（168–213）** 与 **Phase 4（335–347）**：标注被归档取代（不要静默删历史；标注为作废）。
- Validation plan / Phasing and follow-ups：去掉 A4，注明 CSI 归档。
- 加一段记录 #17415，说明 A 批现为 A2/A5/A1（非 CSI）。

纯文档改动：格式 + 引用检查，无需重跑 Java。

### 6.2 A1 Layer 2 — 删 `storage_version` 列（需用户决策）

开放问题：activity summary 缺失但 journal 有 activity 数据时，列删后靠什么持久信号驱动重建？
删列前先解决此问题。**等用户决策**，不要擅自开工。

### 6.3 A3 — tool 协议 v2/v3/v4 收敛（需用户决策）

须先统一编码。maintainer 已在 `bright-leaf` worktree 启动（实质是 B3）。**等用户决策/协调。**

### 6.4 旧分支清理（6.1 落地后）

设计文档在本分支修订完成、且主 checkout 并行 B 会话改动由其归属会话提交/暂存后，
主 checkout 切走 `feat/managed-version-convergence-a` 再删。不要动 B 会话未提交的设计文档改动与未跟踪 B-regime 文档。

## 7. 验证环境陷阱

- JDK 21；Maven `~/apache-maven-3.9.12/bin/mvn`；隔离仓库
  `-Dmaven.repo.local=/tmp/verconv-m2`（APFS clone）。sibling SDK 已装于该仓库
  （`com/alibaba/qwencode-sdk/0.1.0-alpha`）。
- Maven 从 `packages/managed-agent-server` 跑。**`-pl verification` 必须带 `-am`**，
  否则 sibling `runtime-*` 模块解析失败（貌似测试红，实则不是）。
- **live-TS Java 集成测试需已构建的 `packages/core/dist` + `packages/cli/dist`** ——
  先从 worktree 根 `npm run build`（已做；陈旧则重建）。
- 去继承环境：`env -u QWEN_RUNTIME_DIR -u QWEN_CODE_MANAGED_NPM_PIN -u QWEN_CODE_NO_RELAUNCH`。
- CLI `tsc` 默认堆 OOM：`NODE_OPTIONS=--max-old-space-size=8192`。
- 并发 vitest 共享 coverage 目录 → ENOENT 崩溃（非测试失败）：用 `--coverage.enabled=false --reporter=basic`。
- 聚焦 Java 示例：
  `mvn -Dmaven.repo.local=/tmp/verconv-m2 -Dcheckstyle.skip=true -Dspotbugs.skip=true -Dtest='ManagedSessionStoreIntegrationTest,ManagedActionsTest' -pl verification -am test`
- 完整门（Checkstyle、SpotBugs、MySQL、全套件）留 CI；本地预算每改动 10 分钟（模块 AGENTS.md）。
