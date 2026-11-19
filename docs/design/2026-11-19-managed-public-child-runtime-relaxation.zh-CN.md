# SSH 与池化 Harness 上的 managed public child agent（D5′）

[English](2026-11-19-managed-public-child-runtime-relaxation.md) | [简体中文](2026-11-19-managed-public-child-runtime-relaxation.zh-CN.md)

状态：已拍板决策（2026-11-19），重新适配到当前 main 并随本改动实施（2026-11-20）。
基线：`origin/main`；见[重适配计划](../plans/2026-11-20-managed-convergence-readapt-main.md)。D5′ 与 D1 profile 塌缩（已放弃）和 D3 删 protocol 1（收窄为 files-on-v2 + external-files 豁免）无关。

## 问题

Public child agent——public Shell 根会话经 `agent` 工具发起的深度 1、内置
`qwen-code` 或扩展 agent 会话——目前只在持久 `local-process` Runtime Broker
加单（非池化）Harness 上准入。两种已经运行 public Shell 会话的部署形态无法发起
child：

- **SSH 绑定 Workspace**（`ssh-process` provisioner）：配置门
  `ManagedAgentProperties.admitsPublicChildAgents()` 要求
  `provisioner=local-process`，根准入 additionally 要求 SSH Workspace 开启
  managed extension execution。connector 还把每个 SSH 会话标为
  `foregroundOnly`（除非它是扩展启用部署里的 public child 根），从而抑制
  worker 的 child lane。
- **池化 Harness**（Harness pool discovery `static` 或 `kubernetes`，即 worker
  以 Kubernetes pod 运行的生产形态）：`HarnessPoolConnector` 继承默认
  `supportsPublicChildAgents() == false`，每端点的
  `QwenHostedHarnessConnector` 在 `poolEndpoint != null` 时拒绝。

worker 已经无条件广告 `public-child-agents/1`——单实例与池实例 alike——并且
完全由控制面的 `foregroundOnly` 与 `suppressChildAgents` 标志驱动 child lane。
因此排除是一组控制面门控，而非 worker 能力缺失。

## 决策（D5′，2026-11-19 锁定）

将 public child 准入放宽到 **SSH runtime 与池化 Harness**，以**既有能力检查**
门控（feature 协商、lifecycle v2 Shell、session 隔离、SSH 节点配置）。用户四个
收敛答案固定了形态：canonical `/1` profile 保留、退役后缀拒绝、lifecycle
protocol 1 删除（D3）、public child 放宽（本改动）。

**范围外——CSI resident Workspace（`kubernetes-workspace`）。** resident
Workspace 是 files-only、单会话、workspace 级隔离。它们不是放宽对象；决策里的
「k8s」指池化 Harness worker（Kubernetes pod），2026-11-19 已与用户确认。
其排除是结构性的，而非 resident 准入门：provisioner 能力臂只准入持久
local-process 与 SSH runtime，且 `WorkspaceToolProfiles.isPublicShell` 拒绝
resident Workspace 所持的 files-only profile，public child 根门因此永不准入。

## 当前门链

1. `ManagedAgentProperties.admitsPublicChildAgents()`——child-agents 与 Shell
   开关开启、`durableLocalProcess`、`provisioner=local-process`、
   `bound-session-isolation-class=session`。
2. `HarnessConnector.supportsPublicChildAgents()`——pool connector：默认
   `false`；单 connector：`poolEndpoint == null` +
   `public-child-agents/1` feature（构建于 `approval-selection/1` 之上）+
   lifecycle v2 Shell。
3. 根准入（`AgentSessionAdmissions`）——`workspaceChildAgentsEnabled &&
publicChildrenSupported && (!sshWorkspace ||
managedExtensionExecutionEnabled) && (managedExtensionExecutionEnabled ||
无 definition digest 的内置 qwen-code) && isPublicShell(profile)`。
4. child 准入（`AgentSessionAdmissions.insertChildSession`）——父必须带
   `publicChildAgentsVersion == 1`（resident/CSI 父永不满足）、深度 1、
   launch snapshot v1/v2 校验不变。
5. `QwenHostedHarnessConnector.foregroundOnly(session)`——SSH Workspace 强制
   `foregroundOnly`，除非会话是 public child 根且两个扩展开关都开；worker 仅在
   `!foregroundOnly` 时挂 `childRuns`/`childAgents`，并以
   `publicChildLaunchEnabled`（`suppressChildAgents` 的反，connector 由
   `publicChildLaunchAvailable` 计算）门控 `agent` 工具发起。

## 改动

无协议或 schema 改动，D5′ 放宽本身也不需要 worker 改动。随附的 D3 files-on-v2
改动确实改变 worker 契约广告：`hosted-harness-contract.ts` 把
`hosted-workspace-files/1` 加入 `LIFECYCLE_V2_PROFILES` 与默认 profile 列表，
旧 worker 无法广告它（`createHostedHarnessContract` 拒绝未知 profile）。
因此控制面与 worker 必须一起部署——v2 列表缺 `files/1` 的旧 worker 会使普通
files close 返回 409。五个控制面门控放宽；所有既有能力检查保留。

1. **配置**——`admitsPublicChildAgents()` 保留 local 臂
   （`durableLocalProcess` + `local-process`），新增 SSH 臂，镜像既有
   `sshFiles` 能力表达式：`provisioner=ssh-process`、至少一个已配置 SSH 节点、
   `isolation-class=session` 且 `bound-session-isolation-class=session`。
   child-agents 与 Shell 开关仍必需。
2. **Pool connector**——`HarnessPoolConnector.supportsPublicChildAgents()`
   读协商后的 pool contract：`public-child-agents/1` feature token（连同其
   `approval-selection/1` 依赖，共享一份 `HarnessFeature` 定义）与
   `supportsLifecycle(SHELL)`（协商到 lifecycle v2 profile）。worker 不广告
   该 feature 的 pool 仍拒绝。
3. **单 connector**——`QwenHostedHarnessConnector.supportsPublicChildAgents()`
   去掉 `poolEndpoint == null` 合取项；feature 与 lifecycle v2 Shell 检查保留。
   pool 内部的每端点 connector 因此在其 worker 广告该能力时返回 true。
4. **根准入**——去掉 SSH 专属的扩展执行合取项
   `(!sshWorkspace || managedExtensionExecutionEnabled)`。SSH 根与 local 根
   同臂准入 child：无 definition digest 的内置 `qwen-code`，或 managed
   extension execution 开启时的任何已准入 agent。public Shell profile 要求与
   `publicChildrenSupported` harness 能力保留；resident/CSI Workspace 仍被
   结构性排除（provisioner 臂 + `isPublicShell`）。
5. **foregroundOnly**——SSH 例外改为能力谓词（`publicChildAgentsVersion == 1`
   且配置准入且 harness 能力，三者合取），取代两个扩展开关。有能力的 SSH public child
   会话保留背景表面——根与其深度 1 child alike，既有 SSH 扩展 child 不因放宽
   被收紧。无能力部署保持 foreground-only，fail-closed。发起门仍仅限根：
   `publicChildLaunchAvailable` 附加无 lineage 合取项，child 的 `agent` 工具
   仍被抑制（深度 1）。

`configuration-descriptions.json` 与 README 描述放宽后的准入（能力门控、
local-process 或 SSH、单或池化 Harness）。

## 保留的不变量

- CSI resident 排除：结构性——provisioner 能力臂只准入 local-process/SSH，
  `isPublicShell` 拒绝 resident 的 files-only profile；child 门经父的
  `publicChildAgentsVersion` 继承该排除。
- 深度 1、launch snapshot v1/v2 校验、model-route 与 extension-agent snapshot
  检查：不变。
- bound Session 的 session 隔离（SSH 恒用）；child Workspace（独立的
  snapshot-child 特性，`child-workspaces-enabled`）仍要求持久 local-process
  Broker——public child 共享父 Workspace，不需要 child Workspace。
- legacy 执行体制冻结；lifecycle protocol 0 不动（D3 边界）。
- Fail-closed 能力协商：不带 `public-child-agents/1`（或不带
  `approval-selection/1`）的旧 worker 在单与 pool 模式下都保持 child 拒绝；
  `suppressChildAgents` 随之在 worker 上抑制 `agent` 工具。

## 风险

- **SSH child runtime 放置**：child 是绑定父 Workspace 的普通会话；
  `ssh-process` provider 已经按会话放置 session 级 worker。不引入新放置路径。
- **Pool 放置与 drain**：child 会话走既有 placement store 与实例生命周期；
  被 drain 的实例通过与任何会话相同的恢复路径 relocation。feature 门确保只有
  声明该能力的 worker 接收 child。
- **foregroundOnly 放宽**：有能力的 SSH public child 会话获得扩展启用例外早已
  授予的同一背景表面；该例外严格窄于「所有 SSH 会话」，以准入的能力而非部署
  代理为键。深度 1 child 保留表面但永不获得发起门，嵌套仍被拒绝。

## 验证计划

- Java 聚焦：`admitsPublicChildAgents` SSH 臂（节点、隔离、provisioner 矩阵）；
  无扩展执行的 SSH 根准入（内置与扩展臂）、resident 仍拒绝；pool connector
  feature 门（广告 vs 缺 token、lifecycle v2 Shell）；单 connector pool 端点
  能力；`foregroundOnly` 例外（有能力根获例外，SSH child 与无能力根保持
  foreground-only）。
- D1/D3 既有聚焦套件保持绿（lifecycle、admission、connector、preflight、
  retry/terminal、retention）。
- Checkstyle 双 execution；`npm run build`；worker 标志契约不变，既有 TS
  harness-session 套件无需生产改动即覆盖 lane 挂载与发起门。
- MySQL IT 与完整 CI 层级仍是集成门。

## 验收标准

- SSH 部署（ssh-process、已配节点、session 隔离）加广告能力的 Harness 在
  public Shell 根上准入 public child（内置或扩展），内置臂不要求 managed
  extension execution。
- contract 广告 `public-child-agents/1` 与 lifecycle v2 Shell 的池化 Harness
  准入 public child；缺 token 的 pool 拒绝。
- CSI resident Workspace、深度 > 1、非法 snapshot、无能力 worker 的拒绝与
  之前完全一致。
- 无协议或 schema 改动；worker 契约广告新增 `hosted-workspace-files/1`（D3），
  控制面与 worker 须一起部署；配置描述与 README 与放宽后的准入一致。

## 开放问题

无——k8s 语义（池化 Harness worker，而非 CSI resident）已于 2026-11-19 与
用户确认。
