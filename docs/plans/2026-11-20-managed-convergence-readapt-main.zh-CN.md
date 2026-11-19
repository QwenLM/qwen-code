# 将 managed 收敛（D3 files-on-v2 + D5′）重新适配到当前 main

[English](2026-11-20-managed-convergence-readapt-main.md) | [简体中文](2026-11-20-managed-convergence-readapt-main.zh-CN.md)

状态：已拍板决策（2026-11-20），实施留待新会话。
实施基线：`origin/main`（先 fetch；旧分支落后约 303 提交）。
参考提交（复用其逻辑，**不要 merge**）：分支 `worktree-d1-profile-rollout` 上的 `8e6ad15b72`（D1/D3）与 `e54fde47e2`（D5′）。

## 本计划为何存在

收敛分支 `worktree-d1-profile-rollout` 对着冻结在 ~2026-11-13 的基线实施了 D1（profile 塌缩）、D3（files-on-v2 后删 protocol 1）、D5′（public child 放宽）。当前 main 此后合并了两个方向相反的特性，直接 merge 会产生 32 个**语义级**而非机械级冲突：

- **#17272（2026-11-16）——/loop profile 阶梯。** main 刻意区分 `shell/1`（基础）、`shell/3`（自-paced：loop_wakeup + cron 联合）、`shell/4`（固定间隔：仅 cron_create）、`files/1`（基础）、`files/3`（todo_write）、`files/4`（cron 三件套、无 loop_wakeup）。managed /loop skill 变体按 profile 选择，阶梯接线遍布 worker 数十处（工具声明、skill 选择、`lifecycleV2Profiles` 含 `shell/4`）。D1 的塌缩到 /1 + 全标配抹掉这一区分并破坏 skill 选择。
- **#15684（2026-11-15）——external workspace 执行。** main 新增 `hosted-workspace-external-files/1`（仅内置 qwen-code；无 hooks/mcp/skills/plan/memory；仅文本输入），并跑在 lifecycle **v1**：`lifecycleProtocol(EXTERNAL_FILES) == 1`，`ExternalWorkspaceSessionPolicies.admitsLegacyClose` 豁免 external-files 会话的 v1-close 拒绝。D3 的一刀切删 protocol 1 会破坏 external 关闭。main 的普通 `files/1` 也仍在 v1。

## 决策（用户，2026-11-20）

1. **D1 放弃。** 保留 main 的 /loop 阶梯。D1 的退役（files/2、shell/2）main 已完成；其工具标配被阶梯取代。不塌缩 profile。
2. **D3 收窄为 files-on-v2 + external 豁免。** 普通 `files/1` 迁 lifecycle v2（旧 Phase A）。`external-files/1` 保留 protocol 1（其 runtime 不支持 v2 资源阶段）。`shell/*` 与 `mcp/1` 在 main 已 v2。protocol 0 legacy 冻结。旧 Phase B（一刀切删 v1：能力字段、sdk v1 构造器、worker v1 路径）**放弃**——external 仍需 v1。
3. **D5′ 按已实施保留**（public child 放宽到 SSH + 池化 Harness）。可干净应用于 main。

净实施范围 = **旧 Phase A（files-on-v2）+ D5′**，在当前 main 上重新应用。旧分支上的 A 系列版本收敛提交（A2 minimum-reader、A5 action options）属另一系列，**不在本范围**；其去留另行决定。

## 已核实的 main 事实（2026-11-20 读自 origin/main）

- `WorkspaceProfileLifecycleVerifier.verifyResources(op, bindings, profile)`：`verifyEffects` + `verifyMcpResources`；MCP 提前 return；`!isPublicShell(profile) → unsettled()`；否则 `verifyShellResources`。普通 files 在此被拒——Phase A 加 files 分支（verifyEffects + verifyMcpResources 后 return，类似 MCP）。main 的 `isPublicShell` 含 `shell/1`、`shell/3`、`shell/4`。EXTERNAL_FILES 非 public shell，过不了 v2 资源阶段（与 external v1 豁免一致）。
- `WorkspaceToolProfiles.lifecycleProtocol(String)`：FILES→1、EXTERNAL_FILES→1、SHELL/SHELL_V3/SHELL_V4/MCP→2、其余 0。Phase A 仅改 FILES→2；EXTERNAL_FILES 保持 1。
- `WorkspaceToolProfiles.lifecycleProtocol(int)`：接受 1||2（operationIsLifecycle）。**保持接受 1**——external 操作是 v1。**不要**改成 `==2`。
- `QwenHostedHarnessConnector.foregroundOnly(session)`：`sshWorkspace && !(publicChildAgentsVersion==1 && extensions.enabled && managedExtensions.enabled)`——与 D5′ 前形态一致；D5′ 用能力谓词替换该例外。
- `HarnessPoolConnector`：无 `supportsPublicChildAgents` override（继承默认 false）。D5′ 新增。
- worker `hosted-harness-contract.ts`：`LIFECYCLE_V2_PROFILES` 允许集从 `shell/1` 起（读完整列表——含 shell 阶梯与 mcp）；env 默认 `QWEN_HOSTED_LIFECYCLE_V2_PROFILES` = `hosted-workspace-shell/1`。Phase A 把 `files/1` 加入允许集与默认。
- `AgentSessionAdmissions` 根 public-child 门仍有 `(!sshWorkspace || managedExtensionExecutionEnabled)`；D5′ 删该合取项（保留 `!resident`）。
- `AgentLifecycleOperations` v1-close 拒绝：`protocolVersion == 1 && !workspaceFilesEnabled && !ExternalWorkspaceSessionPolicies.admitsLegacyClose(session, workspaces)`。**保留此形态**（external 豁免）；不要套用旧 Phase B 删除。

## 实施步骤（新会话）

1. `git fetch origin main`。从 `origin/main` 切新实施分支（如 `feat/managed-files-v2-public-child-convergence`），在本 worktree 或新 worktree。**不要** merge 旧收敛分支。
2. **Phase A（files-on-v2）**——复用 `8e6ad15b72` 的逻辑，限定 files：
   - `WorkspaceProfileLifecycleVerifier.verifyResources`：加 files 分支（verifyEffects + verifyMcpResources 后 return；跳过 verifyShellResources）。确认 files 关闭不变量由 verifyExecutions + retireOwedFileHistory 覆盖（旧 Phase A 分析）。
   - `WorkspaceToolProfiles.lifecycleProtocol(String)`：FILES→2（EXTERNAL_FILES 保持 1）。
   - `QwenHostedHarnessConnector.supportsLifecycle`：files 走 v2 分支，保留 `isWorkspaceFilesAvailable` 门。`HarnessPoolConnector.supportsLifecycle`：同（main 可能已有 v2 profile 形态——先读）。
   - `ManagedAgentPreflight.lifecycleCheck`：files 经 v2 准入（读 main 当前形态；旧死 v1 检查可能不同）。
   - worker contract：`LIFECYCLE_V2_PROFILES` 与 env 默认加 `files/1`。worker lifecycle 端点 v2 路径天然支持 files（无需额外改）。
   - **不要**动 `lifecycleProtocol(int)`、v1 能力字段、sdk v1 构造器、worker v1 路径（external 需要）。
3. **D5′**——整体复用 `e54fde47e2`（与塌缩/删 v1 无关）：
   - `ManagedAgentProperties.admitsPublicChildAgents()`：加 SSH 臂（ssh-process + 节点 + 双 session 隔离），保留 local 臂。
   - `HarnessPoolConnector.supportsPublicChildAgents()`：新 override，读协商 contract 的 `public-child-agents/1` feature（含 `approval-selection/1` 依赖）+ `supportsLifecycle(SHELL)`。
   - `QwenHostedHarnessConnector.supportsPublicChildAgents()`：删 `poolEndpoint == null`。
   - `AgentSessionAdmissions`：删 `(!sshWorkspace || managedExtensionExecutionEnabled)`，保留 `!resident`。
   - `foregroundOnly`：抽 `publicChildCapabilityAdmitted`（version==1 + 配置准入 + harness 能力，**不含 lineage**）作 SSH 例外；`publicChildLaunchAvailable` 保留无 lineage 合取（发起门仅根，深度 1）。
4. **测试**——从参考提交移植相关测试，适配 main 阶梯：
   - Phase A：`WorkspaceProfileLifecycleTest` files-v2 用例、`SessionLifecycleProtocolChoiceTest`、preflight files-v2、worker contract files 默认。保留 external-v1 与 shell 阶梯测试。
   - D5′：`ManagedAgentPropertiesTest` SSH 臂矩阵；`ManagedWorkspaceAdmissionTest` SSH 根+child 准入（需开放 SSH ma_storage 行带 registration_json nodeId + context SSH 设置 mutate 并 try/finally 还原 + node Access 授权——见参考测试）；`HarnessPoolConnectorTest` feature 门；`QwenHostedHarnessConnectorTest` pool 端点 + foregroundOnly child 表面用例。
   - **不要**移植塌缩断言或删 v1 见证（与 main 矛盾）。
5. **文档**：更新 `docs/design/workspace-profile-lifecycle.md`(.zh-CN) 记录 files-on-v2 + external v1 豁免（**非**一刀切删 v1）。D5′ 设计文档 `2026-11-19-managed-public-child-runtime-relaxation.md`(.zh-CN) 可沿用。D5′ 描述改动后重生成配置参考（`node scripts/generate-managed-agent-configuration-reference.mjs` + `--check`）。
6. **验证**（隔离 Maven 仓库 `/tmp/<task>-m2`，`env -u QWEN_RUNTIME_DIR`）：若动 sdk-java 先重装 sibling（`-Dgpg.skip=true`）；Java 聚焦（lifecycle/admission/connector/preflight/properties/pool）+ Checkstyle 双 execution（`checkstyle:check checkstyle:check@runtime-broker-checkstyle`）；`npm run build`；TS 聚焦（contract + harness-session + managed-local-serve）；若动 sdk 跑 sdk 聚焦。MySQL IT / 全层级 → CI。
7. 推送到 `fork` 的描述性分支；按 `.github/pull_request_template.md` 向 `QwenLM/qwen-code` main 开 PR（双语、不硬换行）。标题如 `refactor(managed-agent): files-on-v2 lifecycle and public child relaxation (D3/D5′)`。

## 约束 / 不变量

- 保留 main 的 /loop 阶梯与 external-files v1；不回退 #17272 / #15684。
- protocol 0 legacy 冻结；public child 深度 1；resident CSI 排除；session 隔离。
- 仓库约定：merge main（活跃 PR 禁 rebase/force-push）；合并时 squash。
- Java 文件末尾换行（Checkstyle NewlineAtEndOfFile）；`write_file` 会吃掉——用 `edit` 或补 `\n`。
- 父会话周期 git status 抢 index.lock：用 add+commit 重试循环；陈旧锁（>90s、无 lsof 持有者）可删。

## 开放问题

- A 系列（A2/A5）去留：另行决策，不在本范围。
- 普通 files-on-v2 在 main 是否需要 rollout 开关（旧 Phase A 设为默认；确认 main 没有须翻动的 files-v1 rollout 守卫）。
