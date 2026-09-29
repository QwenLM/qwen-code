# Managed Agent：有效配置、初始化、Skills、MCP 与 Hooks

更新日期：2026-09-11；生产源码基线 `a836081466`，既有设计基线 `4cacfbd0ed`。本文定义[全量覆盖表](managed-agent-full-design.md)的 C03/C07/C08/C09，采用[Session 存储](managed-agent-session-storage.md)、[私有协议](managed-agent-control-protocol.md)、[完整 Harness](managed-agent-harness.md)与[coordinator](managed-agent-coordinator.md)的身份、提交和生命周期契约。第 1 节描述现有源码；其后新增类型、版本化适配与恢复保证均待实现和验收。

首阶段仍延期完整 Skills/MCP/Hooks 迁移，详细设计在本文完成。未具备相应能力的新 Session 按正向兼容证明固定 legacy；已存在 Managed 遇到不支持的变更明确拒绝或阻塞恢复，不切换引擎重跑。独立 CLI/TUI 与旧公开返回、错误时机和输入额度保持原兼容边界。

## 1. 当前事实：不能省略的来源与消费者

| 域          | 当前来源、顺序与读站点                                                                                                                                                                                                                                                                                                                                                                  | 下游实际消费者/差异                                                                                                                                                                                                                                                           |
| ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 根          | `config/environment.ts:109` home dotenv 可预解析 QWEN_HOME/QWEN_RUNTIME_DIR；`storage-paths-lite.ts:36–66` 的 global/system/default settings 路径仍读 process.env；Core `config/storage.ts:153–209` pinned runtime context 只固定 runtimeBaseDir，global Qwen 路径仍读 process.env                                                                                                      | settings、OAuth、commands、Skills、extensions、memory、audit、trust/MCP approvals、transcripts/locks 均须固定到正确根；当前传 runtimeEnvironment 不是这些根全部隔离的证明                                                                                                     |
| settings    | `settings.ts:436` defaults < user < trusted workspace < system，按既有字段 merge strategy；项目 restricted 字段先剥离；`:797–835,1095–1185` snapshot 只读/内存迁移/显式 env 插值与 trust，但路径 getter 仍是全局的                                                                                                                                                                      | `loadCliConfig:1270+` 组装 cwd、模型、权限、工具、safe/bare、MCP、memory、extensions、Skills；selector、bootstrap、per-Session new/load/resume、reload 必须使用同一输入集合                                                                                                   |
| dotenv/env  | `environment.ts:267–355` 从真实 cwd 向上寻找首个 `.qwen/.env` 或 `.env`，然后 global Qwen/home 候选；遇到 home 使用 home 候选。用户级文件豁免项目 trust，项目按其目录 trust。`:523–585` baseEnv 先占值，dotenv 按顺序填 unset/空值，再 settings.env 填 unset；loader/private/project 禁用变量沿现有过滤                                                                                 | host bootstrap env 与 workspace effectiveEnv 不是同一对象；settings 的显式 env 插值不再补隐式 home fallback。MCP stdio `mcp-client.ts:2557`、命令 Hook `hookRunner.ts:1081` 仍继承 process.env，HTTP Hook env 插值也未吃 workspace 快照                                       |
| argv / 请求 | `config.ts:1180` `--mcp-config` 支持文件/JSON；`:1972` session MCP < CLI MCP。`managed-agent-channel.ts:95–195` 克隆 argv，重置 host Session ID/resume 标记，私有父能力和 workspace 实路径匹配后装配完整 ACP host                                                                                                                                                                       | argv 相对路径须固定原解析 cwd；session/new 的 cwd、MCP、trust、模型/模式和 load/resume 元数据不能被 bootstrap argv 覆盖；认证/TLS/代理和私有 daemon 环境不能跟普通项目 env 混合                                                                                               |
| MCP 来源    | `mcpServers.ts`：user/default < `.mcp.json` < workspace/system < session < CLI；Core `config.ts:6539–6579` 再补缺省的 active-extension server（同名 first active wins），runtime overlay 最后覆盖；safe 保留显式 top-tier，bare 在组装阶段剥掉 ambient                                                                                                                                  | name allowlist、disabled/excluded、pending approval 是独立 admission，不等于没有配置。`.mcp.json` approval 绑定 project+name+精确配置 hash（`mcpApprovals.ts:20–49`），发现与资源 lazy-spawn 都先 gate                                                                        |
| extension   | `extensionManager.ts:1263–1318` 用 ExtensionStore 一致快照读取 global/user 安装或 linked sources；`:1503–1680` Qwen / agent-plugin 格式、manifest MCP、skills、内嵌/独立 hooks 文件，替换 extension root 变量；启用/禁用与 workspace 偏好参与 active                                                                                                                                    | 不是独立第二区域：扩展产物注入 SkillManager、HookRegistry、MCP map、context/commands/subagents；sources 无 watcher，`:1429` source fingerprint 再检查；linked source 也不能仅凭目录空/工具数零判定支持                                                                        |
| 初始化      | Core `Config.initializeOnce:3051` writer/owner 激活在 initializeInternal 前；`:3110–3500` FileService→Prompt/ResourceRegistry→extension 首读→HookSystem→SubagentManager→SkillManager/curator/watch→PermissionManager→session agents→extension integration→hierarchical memory→ToolRegistry/MCP discovery→LlmClient/模型 warm                                                            | `refreshHierarchicalMemory:3973` QWEN.md/AGENTS/rules/extension context、conditional rules 和 InstructionsLoaded callback；safe 不读 context，bare explicitOnly。初始化本身会写 cache/curator/Goal，不能拿完整 Config 初始化当 selector 的只读探针                            |
| Skills      | `skill-manager.ts:281–355` project > user > extension > bundled；`:913–986` project provider 配置目录、QWEN_HOME 用户目录、home 兼容目录、custom dirs、active extensions、bundled；safe 仅 bundled，bare 无；projectRoot==home 跳过 project                                                                                                                                             | cached listing、模型 available_skills、Skill tool 校验/调用、slash/completion、context 计量、子 agent 均是消费者；`loadSkillForRuntime:391` 重新按名字解析文件，并非按发现时内容执行。`:423` refresh 重建 paths activation，`:542,578` path activation/watch 通知下游         |
| Skill 执行  | `tools/skill.ts:525–739` 再校验 disabled/conditional、加载正文、去重、session allowedTools、session hooks、modelOverride；`SkillCommandLoader.ts:145–190` slash 同样加 permission rules，写/清除 skill args 文件再提交正文；两条现有路径副作用不完全相同                                                                                                                                | `registerSkillHooks.ts:69–99` skillRoot+完整配置去重，Hook 持续到 Session end（unload 不注销）；`skills/symlinkScope.ts:10–34` 明确允许用户管理的外部软链目录，不能迁移时一概加根内约束                                                                                       |
| Hook 来源   | `LoadedSettings.getUserHooks/getProjectHooks:689–704` 读取原 user/workspace，但 CLI `config.ts:2277–2282` 的 userHooks 在 undefined 时回退 merged hooks，且一直传 deprecated hooks；Core `Config.get*Hooks:8321–8351` 也会回退 deprecated merged hooks（project 仍受 trust gate）。`HookRegistry:254–276,455` 按 project→user→system→extensions 排序，另拼动态 session/skill/agent 注册 | **System 枚举不代表独立 source 装载，但 system/default 定义可能经 merged fallback 实际执行并标为 User/Project。**不能只读两个 getter 就说 system/default 不运行。目标保留原 effective plan 的 fallback 行为和真实来源诊断，不能迁移时新增/丢失/重复命令                       |
| Hook 执行   | `HookPlanner:109–145` matcher+去重，任一 sequential 即全批 sequential；`HookEventHandler:810–930` registry plan 后拼 session hooks，统一 runner/aggregator。`hookRunner:847–970` parallel Promise.all；sequential 把成功输出变成下一项 input，遇 abort 停后续，不能擅改成“第一个 block 就 break”                                                                                        | 4 runner：command（含 async）、HTTP、prompt、function。prompt `promptHookRunner:215–323` 当前/显式模型，override resolveForModel(failClosed)，ContentGenerator，500 output token；非阻断错误与 cancelled 区分。function 持有 callback/context/messages/回调，不能 JSON 序列化 |

表内 settings/environment/mcpServers/mcpApprovals/config 装配位于 `packages/cli/src/config/`，managed-agent-channel 位于 `packages/cli/src/serve/`；Core 的 config、tools、skills、hooks、extension 文件位于 `packages/core/src/`。公开 Bridge 方法采用[268 项逐方法映射](managed-agent-session-method-map.md)，本专项不替换其同步/异步返回形状。

## 2. 配置归属、根和凭据类型

选择**一个来源解析器、Harness/Runtime 两个执行视图、Session 唯一版本事实**。CLI 层保留 settings/env/argv 原生解析与 merge 算法，Core 接收已解析不可变输入；不复制配置解析到 Runtime。文件读取改为可注入 SourceReader，解析器不依赖某个物理 host 的全局 env/cwd。Workspace 控制层拥有读取与更新；Session authority 提交版本；Harness 消费模型/提示/权限视图；Runtime 消费文件/命令/网络视图。每个 view 都引用同一 bundle revision，不传完整 Config。

```ts
type RootSnapshotRef = DurableRef & {
  kind: 'managed-root-snapshot';
  schemaVersion: 1;
};
type ActivationFence = Pick<
  ActivationGrant,
  'activationId' | 'epoch' | 'workerId' | 'subject' | 'definitionRevision'
> & { sessionKey: SessionKey; workspaceGeneration: number };
interface SecretHandle {
  v: 1;
  bindingId: string;
  brokerId: string;
  scope: {
    tenantId: string;
    workspaceId: string;
    sessionId?: string;
    clientId?: string;
  };
  purpose: 'model' | 'mcp' | 'hook' | 'runtime_environment';
  credentialGeneration: number;
  audienceRef: DurableRef;
  expiresAt: number;
}
type ConfigSourceKind =
  | 'system-defaults'
  | 'system'
  | 'user'
  | 'project'
  | 'dotenv'
  | 'argv'
  | 'session'
  | 'extension'
  | 'runtime'
  | 'client'
  | 'bundled';
interface SourceStamp {
  sourceId: string;
  kind: ConfigSourceKind;
  ownerScope: string;
  sourceRevision: string;
  presence: 'present' | 'absent';
  digest?: string;
} // 错误不是 absent
interface SourceError {
  sourceId: string;
  code: 'unreadable' | 'invalid' | 'changed' | 'unsupported_version';
  detailRef?: DurableRef;
}
interface RootSnapshot {
  v: 1;
  hostId: string;
  workspaceId: string;
  generation: number;
  launchCwd: string;
  cwd: string;
  projectRoot: string;
  osHome: string;
  platform: string;
  configRoot: string;
  runtimeBaseDir: string;
  paths: RootPaths;
  sources: SourceStamp[];
}
interface RootPaths {
  userSettings: string;
  systemSettings: string;
  systemDefaults: string;
  workspaceSettings: string;
  projectMcp: string;
  trustFile: string;
  mcpApprovals: string;
  oauthRoot: string;
  commands: string[];
  skills: string[];
  extensionStore: string;
  memory: string[];
}
interface ConfigReadRequest {
  root: RootSnapshotRef;
  argvRef: DurableRef;
  sessionOverridesRef: DurableRef;
  baseEnvironmentHandle: SecretHandle;
  trustRevision: number;
  expectedSourceRevision?: string;
}
interface EffectiveConfigBundle {
  v: 1;
  revision: number;
  definitionRevision: number;
  root: RootSnapshotRef;
  sources: SourceStamp[];
  trustRevision: number;
  permissionRevision: number;
  modelPolicyRef: DurableRef;
  harnessViewRef: DurableRef;
  runtimeViewRef: DurableRef;
  skillCatalogRef: DurableRef;
  mcpCatalogRef: DurableRef;
  hookCatalogRef: DurableRef;
  privateBindings: SecretHandle[];
}
interface ConfigSnapshotResolver {
  read(request: ConfigReadRequest): Promise<PreparedConfigBundle>;
}
interface WorkspaceConfigurationController {
  prepare(request: ConfigReadRequest): Promise<PreparedConfigBundle>;
  install(request: ConfigInstallCommand): Promise<ConfigInstallReceipt>;
  status(request: ConfigOperationLookup): Promise<ConfigInstallStatus>;
}
type WorkspaceKey = { tenantId: string; workspaceId: string };
interface WorkspaceConfigCommandMeta {
  v: 1;
  workspaceKey: WorkspaceKey;
  workspaceGeneration: number;
  operation: 'config_install' | 'workspace_initialization';
  commandId: string;
  contentDigest: string;
}
type ConfigOperationLookup =
  | {
      scope: 'workspace';
      workspaceKey: WorkspaceKey;
      workspaceGeneration: number;
      operationId: string;
    }
  | { scope: 'session'; sessionKey: SessionKey; operationId: string };
type ConfigInstallCommand = {
  preparedId: string;
  expectedRevision: number;
  preparedBundleRef: DurableRef;
} & (
  | {
      scope: 'workspace';
      meta: WorkspaceConfigCommandMeta;
      operationGrant: WorkspaceOperationGrant;
    }
  | {
      scope: 'session';
      meta: CommandMeta;
      operationGrant: OperationGrant;
      workspaceInstallRef: DurableRef;
    }
);
type SessionCommitReceipt = CommitReceipt;
interface WorkspaceConfigCommitReceipt {
  workspaceKey: WorkspaceKey;
  workspaceGeneration: number;
  commandId: string;
  operationId: string;
  revision: number;
  installedSnapshotRef: DurableRef;
  metadataDigest: string;
  duplicate: boolean;
}
type ConfigInstallReceipt = {
  operationId: string;
  revision: number;
  bundleRef: DurableRef;
  stageAckRefs: DurableRef[];
  enableAckRefs: DurableRef[];
  state: 'committed' | 'active';
} & (
  | {
      scope: 'workspace';
      commit: WorkspaceConfigCommitReceipt;
      installedSnapshotRef: DurableRef;
    }
  | {
      scope: 'session';
      commit: SessionCommitReceipt;
      workspaceInstallRef: DurableRef;
    }
);
interface PreparedConfigBundle {
  preparedId: string;
  bundleRef: DurableRef;
  expectedRevision: number;
  sourceProofRef: DurableRef;
}
interface ConfigInstallStatus {
  operationId: string;
  revision: number;
  state:
    | 'prepared'
    | 'installing'
    | 'committed'
    | 'active'
    | 'retiring'
    | 'released'
    | 'rejected';
  receipt?: ConfigInstallReceipt;
  errorRef?: DurableRef;
}
```

`DurableRef`、SessionKey、CommandMeta、CommitReceipt、ActivationGrant、InvocationBinding、OperationGrant 与 WorkspaceOperationGrant 采用私有协议与存储规范。`RootSnapshotRef` 明确约束资源 kind/version，资源正文是本节 RootSnapshot；字节长度、digest、归属和引用闭包由原资源验证器核对。RootSnapshot/非秘密配置与组件 snapshot 都走同一资源格式，workspace 安装资产按存储 §2.1 的 workspace_owned 归属落盘，在 Session 创建前即可存在；Session 绑定先取得独立持久授权引用，再提交 config.bound。删除某个 Session 只释放其引用，不能删除仍安装的配置或其他 Session 正使用的 snapshot；Session 专用 snapshot 才使用 session_owned。不新建 Session journal。路径来自可信 root resolver，payload 不能任意指定其他 workspace 路径。SourceStamp 对 file/directory 保存一致快照身份证据，read 期间删除/替换/损坏拒绝；存在性不证明内容正确。完整文本/headers/env 不写 stamp、日志或索引；含 secret 的源使用 broker 的 opaque revision 或带密钥 fingerprint，避免对低熵凭据暴露裸 hash。

固定根步骤：从 host launch cwd、osHome、启动 env/argv 得到 user-level home override→canonical RootSnapshot→冻结 host bootstrap env→按每个候选目录 trust 解析 workspace env→以该 env 解析 settings→受控 session/argv 覆盖→扩展与三个 catalog。对依赖 settings 的 env 排除项复用原解析阶段次序，不引入循环 fixpoint。现有 relative custom paths/--mcp-config 路径在原解析 cwd 归一化后记录。Tool-only worker 使用 Runtime view，绝不通过重新读全局 settings 获取模型凭据。Runtime 仅能取得明确授予它的 MCP/Hook/命令环境 secret；model-purpose handle 只授予 Harness。

SourceReader 是只读文件域适配：本地复用受控 workspace 文件访问，远端使用已认证 Runtime 的 read-only source capability；读取来源不要求先创建 Harness，也不运行 Config.initialize。selector 读取失败返回未知兼容性，不能为探测开启 worker 工具执行、连接 MCP 或触发 Hook。实际写入、watch、curator、连接或脚本仍需下一节的资格。

RootSnapshot 必须实际注入：Storage/global getters、CLI lite getters、environment 候选查找、trust/MCP approvals、extensionStore、memory/rules、Skill custom path expansion、MCP cwd/env、Hook env interpolation、hostConfig/per-Session Config/worker bootstrap。绝不用临时改 process.env、process.chdir 或静态 Storage setter 模拟多 workspace。根发生变化创建新 workspace generation，原 generation 的 status/cancel/history/release 保留，不能让旧 invocation 读到新根。

Secrets 采用受信任进程内或认证 broker 的 purpose-scoped `SecretHandle`：它是可记录的定位引用，**不是持有即授权的 bearer token**。broker 每次根据真实连接核对 tenant/workspace、可选 session/client 限定、purpose、credentialGeneration、expiresAt 和 audienceRef；缺省 session 仅表示经过显式授权的 workspace 共享，client 范围不得跨连接 epoch。只保存引用/非敏感账号标识，运行时取值，不把 token/header/env 全量写 JSONL/模型上下文。配置文件内混合 secret 的原内容也由 secret store 保管，普通 DurableRef 只存去秘密后的对象。私有 ACP capability/daemon token/activation gate 不进入子命令 env。broker 缺失/过期返回 auth_required，不回退其他账号/root。正常 token refresh 可在核对同一账号、purpose 和 audience 后发布新 handle；记录 credential generation 变更，已开始请求保留原身份与回执，不因更新重发请求。恢复不能取得合法新 handle 时保持 credential_required。

## 3. 版本、更新、恢复的共同状态机

`read → prepared → installing → committed → active → retiring → released`；解析/信任/能力失败为 rejected，安装失败保留上版 active。安装状态属于配置操作，不是第二个模型 activation。安装过程中没有成功 ACK 前不得向新调用发布新版；commit 成功但 ACK 丢失按原 operationId 查询，不能重新提交等价变更。旧 revision 有 invocation/async Hook/MCP lease/continuation 引用时保持 retiring，真实 drain 后释放。

配置安装先区分作用域。workspace 安装由其控制 owner 持久接受 operation、颁发 WorkspaceOperationGrant，封相关新准入并按受影响范围取得 Session/文件 barrier；staging 文件、registry、连接和 watch 后提交实际 installed snapshot，再核对 enable ACK 和提交 enabled phase，返回 WorkspaceConfigCommitReceipt。没有用户 Session 也能执行这一路径，不创建假的 bootstrap Session 或 SessionCommitReceipt。workspace 操作的元数据与结果只描述工作区安装，不复制任何 Session 事实。

改变 definition、初始化依赖或根的已安装 snapshot，再逐个绑定 Session：coordinator 请求安全边界→authority 对配置绑定 operation 颁发 OperationGrant→staging 本 Session view 并核对 stage ACK→单 writer 提交 config_install 领域记录及 config.bound→启用 view、核验 enable ACK 并提交原 operation 的 enabled phase→返回 SessionCommitReceipt，下一 activation 使用新版。配置 revision 以各自 owner 为作用域，bundle revision 由引用单独标识，不假定 workspace revision 等于 Session revision。committed 可查询，但只有完整 enableAckRefs 的 active 回执可发布。多 Session 不存在跨文件原子绑定；未成功者保持已声明旧版或 blocked。

OperationGrant 采用私有协议的 `sessionKey/operationId/domain/operationRevision/ownerId/workspaceGeneration/resourceScope/leaseDurationMs/expiresAt`，Runtime 在单调 per-operation gate 下验证 phase 与原回执。它只授权既定配置操作，不授予模型推进；已 released 的 Harness activation 不会因维护而恢复。配置安装不能拿 stageGate/revokeGate 临时关闭后重开同一 epoch：撤销过的 activation 仍不可重开，下一 activation 必须重新安装其门禁。稳定 phaseOperationId 不随 grant 重领改变，撤销后的同 operationRevision 不可重开。

根版本按 workspace generation 固定，上述 definition 配置 revision 在 activation 安全边界切换；同 invocation 的 prepare/权限确认/preflight/execute/协议重试固定原 revision。当前 definition 已声明允许的原生活跃控制——模型选择、权限模式、Skills enabled/disabled 与 paths catalog、Skill 激活、session Hook/MCP 注册——使用各自领域 revision/调用快照，不改写 definition，也不自领新 epoch；复用各字段现有生效时机，每个新调用绑定其实际生效的组合 revision。字段不在该明确 live-control schema 中时按 definition 变更处理，不靠任意属性热赋值。模型媒体能力按 invocation 采样，不永久冻结到同 prompt；已有调用不随之后换模变化。已展示 approval 的参数/权限/definition 改变必须重新绑定或拒绝旧票。

用户授权的动态 operation 在原 activation 结束后仍可凭其窄 OperationGrant 完成已提交 phase；模型新产生的意图必须先验证当前 activationFence。未决更新在 checkpoint 中保留原 operation/phase，不被恢复当作已生效配置。trust 撤回立即阻断新副作用，存量取消按原 owner；不得通过撤权删掉结算能力。

watch/reload 不直接修改活跃 Config 的全局 Map：先做原生 reload/解析的 staged 副本，提交 catalog revision，再原子替换本 Session 的 view。单文件合法更新不等于全快照一致；任一必需来源 unreadable/unknown version 使新版本 rejected，保留旧版并显示错误。当前原生 best-effort 部分发现保留其 per-source error/stale 标志，不能把 partial snapshot 认证为“无能力配置”。

恢复读取 checkpoint 的根/各 catalog revision、动态注册、once 消耗、permission rules、模型选择和未决 binding；校验引用闭包、信任、credential 可取得、Runtime generation 仍可结算。原 bundle 不再可用则 `recovery_blocked(config_unavailable|trust_changed|credential_required|runtime_unknown)`。正常 user resume 可在安全边界绑定新版；同一次 activation recovery 不能重放 init 副作用、扩展安装、Skill allowedTools、Hook 或 MCP call。

## 4. C07：初始化、上下文、Skills 的明确接口

```ts
interface WorkspaceContextSnapshot {
  v: 1;
  revision: number;
  root: RootSnapshotRef;
  instructionRefs: DurableRef[];
  conditionalRulesRef: DurableRef;
  projectRoot: string;
  extensionRevision: number;
  errors: SourceError[];
}
interface SkillDescriptor {
  id: string;
  revision: number;
  name: string;
  level: 'project' | 'user' | 'extension' | 'bundled';
  source: SourceStamp;
  fileRef: DurableRef;
  assetRootCapability: string;
  flagsRef: DurableRef;
  allowedToolsRef?: DurableRef;
  hooksRef?: DurableRef;
  modelSelector?: string;
}
interface SkillCatalog {
  revision: number;
  descriptors: SkillDescriptor[];
  disabledNames: string[];
  disabledLevels: string[];
  pathActivations: string[];
  sourceErrors: SourceError[];
}
interface SkillActivationRequest {
  operationId: string;
  sessionKey: SessionKey;
  trigger:
    | { kind: 'model' | 'path'; activationFence: ActivationFence }
    | { kind: 'slash'; command: CommandMeta };
  skillId: string;
  skillRevision: number;
  argsRef?: DurableRef;
  expectedPermissionRevision: number;
}
interface SkillActivationReceipt {
  operationId: string;
  bodyRef: DurableRef;
  permissionRevision: number;
  hookRegistrationRefs: DurableRef[];
  modelSelectionRef?: DurableRef;
  argsResourceRef?: DurableRef;
}
```

文件/规则读取通过上述 SourceReader；Harness 复用原 memory parser、SkillManager/parser、Skill tool 与 slash 扩展算法的输入适配，保持模型可见列表、校验、正文来自同 revision。正文与 assets 分开：正文是已提交内容，脚本/附件通过 assetRootCapability 解析真实路径，Runtime 按现有工具权限读取执行；**读取 SKILL.md 不执行 shell**。若 slash/extension 命令有外部扩展步骤，作为单独有身份 Runtime invocation，不藏进 prompt 拼接。

明确保留 project>user>extension>bundled 去重、name 排序、priority 仅 UI、safe/bare、disabled、userInvocable/disableModelInvocation/paths gating、二次校验、同 Session 重复正文抑制。Skill source 变化后新调用用新版；已有加载记录保留原 body/permission/hooks 版本。用户合法跨目录软链保留，用来源信任+实际 target 身份+显式挂载能力授权；禁止把本地绝对路径原样当远端可读路径。远端无此挂载准确 unsupported_asset_root，不伪造技能为空。

Skill activation 由注册配置领域适配提交第 7 节的 `domain.committed`，recordRef 指向 SkillActivationReceipt 的领域记录：正文版本、新增 session permission rules、Hook registrations、模型 selector 及 args resource；这些内容不内联进 event payload。model/path 触发先核对当前 activation；用户 slash 在目录/Session 准入后接受独立 Skill operation，无需伪造尚不存在的模型 activation，生成 prompt 后再走原 submitInput。Runtime 写/清理 skill args 使用原 Skill operation 的 OperationGrant/phase receipt，保留其原 posting-authority 语义；失败不能保留旧 args 却声称已撤销。副作用回执和 domain commit 未齐之前保持 pending，恢复核对原回执，不再执行。不同调用入口保留现有差异，不能让 slash 默认新增其原本没有的 Hook 注册。

初始化分为 read/prepare 与 activate 两步：前者只构建快照；无 Session 的 workspace 初始化/curator/cache/watch/install 使用 WorkspaceOperationGrant 和 workspace 控制 receipt。已有 Session 的初始化在 writer、固定 engine 与对应 activation/OperationGrant 门禁校验后绑定已安装 snapshot，复用 Config 的必要装配顺序。模型推进必须另有 RunnableGrant，不能借初始化资格调用模型。所有物理 phase 都有明确 owner，不能 selector 启动。watcher 属 workspace Runtime，Session view 订阅版本；Harness detach 不停共享 watcher。workspace remove/reload/daemon close 按 generation 关闭新更新、drain 所有回调/写入再释放 watcher；子任务从父亲明确继承的 revision 构造自己的 view，禁止暗读主 workspace 的 Config。

## 5. C08：MCP 的完整域边界

选择 MCP connection/pool 在 Runtime 服务拥有，发现结果作为不可变 catalog 给 Harness；保留 McpClient/McpClientManager/McpTransportPool/SessionMcpView 算法与预算，不再在 Harness 另建客户端。进程共享与否由原 pool key/transport 策略决定，workspace 总预算/ProcessRegistry 必须对 legacy+Managed 共计；不能每个新 view 重置预算。

```ts
interface McpServerDescriptor {
  serverId: string;
  name: string;
  revision: number;
  source: SourceStamp;
  owner: 'workspace' | 'session' | 'client';
  transport: 'stdio' | 'streamable-http' | 'sse' | 'sdk';
  connectionRecipeRef: DurableRef;
  credentialBinding?: SecretHandle;
  admissionRef: DurableRef;
}
type DiscoveryState = 'complete' | 'partial' | 'failed' | 'stale';
interface McpCatalog {
  revision: number;
  server: McpServerDescriptor;
  connectionGeneration: number;
  toolsRef: DurableRef;
  resourcesRef: DurableRef;
  promptsRef: DurableRef;
  discovery: {
    tools: DiscoveryState;
    resources: DiscoveryState;
    prompts: DiscoveryState;
  };
}
interface ManagedMcpService {
  configure(request: McpConfigurationCommand): Promise<ConfigInstallReceipt>;
  discover(serverId: string, revision: number): Promise<McpCatalog>;
  invoke(request: McpOperationBinding): Promise<McpOperationReceipt>; // kind=tool_call|resource_read|prompt_get
  status(binding: McpOperationBinding): Promise<McpOperationStatus>;
  cancel(binding: McpOperationBinding): Promise<McpOperationStatus>;
  release(lease: McpLeaseBinding): Promise<DrainReceipt>;
}
```

`McpOperationBinding` 必需 sessionKey/operationId/configRevision/serverId/serverRevision/connectionGeneration/nativeRequestId/kind/argsRef/deadline。tool_call 必需 activationFence、executionCallId、definition digest、permission receipt；模型发起的 resource/prompt 意图同样先核对 activation。用户显式 resource_read/prompt_get 采用已受理 operation 的 OperationGrant，不伪造模型 grant；resource 有 URI、prompt 有 name/arguments，均必须来自本 session 允许的 server，不接受跨 workspace 的 serverName-only 调用。ManagedMcpService 实例绑定可信 Session/workspace 作用域，不能由方法参数切换 owner。

`McpConfigurationCommand` 使用 CommandMeta、OperationGrant、expectedRevision、action=add/remove/reload、source/owner 与 serverDescriptorRef；add/reload 必须提供经验证定义，remove 只引用原 server/revision。`McpOperationStatus` 返回 binding、phase、pending/settled/outcome_unknown 与 receiptRef；`McpOperationReceipt` 在 settled 时提供原 response/error ref 与 CommitReceipt；`McpLeaseBinding` 是 workspace/session/client owner、serverId/connectionGeneration/leaseId，`DrainReceipt` 记录原 lease、是否真实释放及残留 owner refs。类型按 action/phase 分型，禁止互不相干 optional 字段拼出成功。

旧 ACP resource/prompt 公共返回仍适配原 ReadResourceResult/GetPromptResult/错误形状；内部大数据走 DurableRef，不丢掉 resource blob、mimeType、完整 prompt messages/content union。旧 slash loader 首条文本/JSON.stringify 行为由旧适配保留，不能因新内部 DTO 悄改 UI。

连接状态固定 `configured/pending_approval/connecting/discovering/ready/degraded/auth_required/disconnected/retiring/released`，每一目录有 complete/partial/failed/stale 状态。`mcp-client.ts:733–780` 原生 tools/resources/prompts 并行发现，helper 会吞错误成 []；非 pool 资源空集也保留旧缓存（`:694–705`）。目标在共享 helper 返回领域状态，区分“合法空目录”与失败，旧公开列表仍兼容；跨 catalog 版本不能将失败的 [] 宣布为服务删除全部能力。

stdio：实际 cwd 和 scrubbed env 来自 Runtime view+server override；命令、args、plugin runtime paths 保留原校验；process lease 保活到最后 session/subscription/inflight 引用真实释放。HTTP/SSE：复用原 transport/HTTP compatibility/OAuth refresh/service-account/Google 凭据逻辑，持有 server session 与认证身份，release 对 Streamable HTTP 的终止 DELETE 有界等待（`mcp-client.ts:800+`），本地 transport abort 不等远端副作用撤销。SDK reverse transport：注册 clientId+connection epoch lease，在可信原客户端控制面代理，不能转换为 stdio/HTTP 或分享给其他 client。

resources/list/read、prompts/list/get 都经相同 trust/pending/disabled/budget/connection generation 检查（现有 readResource `mcp-client-manager.ts:2638+` 已有 lazy-spawn gate）。prompt get 会发网络请求，也有 operation receipt；结果是数据，不能授权额外工具或绕过 submitInput。资源订阅/更新和服务 list-changed 通知有 subscriptionId、server generation、catalog revision，旧 generation 通知丢弃，不全局广播。资源 URI 只交给原 server，不能直接在控制层当文件路径打开。

动态 workspace add/remove 更新 Workspace catalog，session add/remove 只改变 Session overlay，client 注入绑定 client lease；保留 settings shadow / runtime overlay、originatorClientId 和实际回执。相同 server 名的配置替换先 staged 新 connection，旧 binding 保留在 retiring，旧调用结束才 release；新 acquire 仍计原总预算，没容量就 wait/reject，不能临时超配。`accepted:true` 仍只代表控制操作准入，discover/connect 状态异步单独回报。

MCP 配置与非工具 resource/prompt 操作采用第 7 节领域记录引用；工具调用仍通过 acceptRuntimeReceipt 形成原 tool.receipt，不能改用 domain 来伪造物理结果。MCP cancel 记录 request 与本地 request settlement；远端确认不明为 outcome_unknown，不把 abort 当远端未执行。复用现有 guarded invocation 禁止内部 reconnect replay（`mcp-tool.ts:527–543`）；新 generation 可以为**后续明确新调用**重连，旧 call 不自动重发。保持原原生非 guard 路径的 trust+readOnly/idempotent 安全重试规则（`:448–523`），不得由远端自报 annotation 单独授予权限。Runtime 丢失且无回执阻塞恢复，server 提供明确查询/幂等协议才可注册额外恢复策略。

## 6. C09：Hooks 的确定性计划、位置和时序

Hook 编排留 Harness/注册领域适配，**执行位置按类型分派**：command 与 HTTP 由 Runtime；prompt 模型调用由 Harness（Tool-only Runtime 绝不认证或调用模型）；function 由可信 host 注册的 handler 保留本域，不能传函数字符串 eval。Runtime preflight 等待模型侧 Hook 时使用现有 invocation 的 pending request/同一个 coordinator owner；不得在 Harness 和 Session.close 各放一套模型 job registry。

```ts
interface HookDescriptor {
  hookId: string;
  revision: number;
  source: SourceStamp;
  executionSourceTag: string;
  registrationScope: 'configured' | 'session' | 'agent' | 'skill' | 'client';
  event: HookEventName;
  matcher?: string;
  sequential: boolean;
  kind: 'command' | 'http' | 'prompt' | 'function';
  definitionRef: DurableRef;
  handlerRef?: RegisteredHandlerRef;
  timeoutMs: number;
  async: boolean;
  onceKey?: string;
}
interface HookPlan {
  planId: string;
  catalogRevision: number;
  sourceResolution: 'native-hook-fallback/1';
  occurrenceId: string;
  event: HookEventName;
  inputRef: DurableRef;
  orderedHooks: Array<{ hookId: string; revision: number }>;
  strategy: 'parallel' | 'sequential';
  ownerScope: string;
}
interface HookExecutionBinding {
  hookExecutionId: string;
  occurrenceId: string;
  ordinal: number;
  sessionKey: SessionKey;
  operationGrant: OperationGrant;
  originatingActivation?: ActivationFence;
  modelActivation?: ActivationFence;
  planRef: DurableRef;
  inputRevision: number;
  runtimeBinding?: InvocationBinding;
  modelAttemptId?: string;
  handlerLease?: string;
}
interface HookReceipt {
  binding: HookExecutionBinding;
  state: 'settled' | 'outcome_unknown';
  outcome?: 'success' | 'blocking' | 'non_blocking_error' | 'cancelled';
  resultRef?: DurableRef;
  physicalStatus?: string;
}
```

`HookConfig/HookInput/HookOutput` 按现有类型完整封闭 union 编码，保留 source_type/source_id/transcript_path/cwd/event/timestamp、tool identity、permissionMode、additionalContext、updatedInput、continue/stop/decision/systemMessage/suppressOutput、artifacts。Runtime 需要读 transcript 时仅授予这一 Session 已提交只读 projection/受控本地副本，不能泄漏 Harness 主机绝对路径作为可执行权限。秘密 env/header 在执行时解析，错误与 telemetry 脱敏，不把完整 prompt/config 回显到用户。

计划先用原 registry+session manager+planner 生成并提交身份，执行结果按 **计划 ordinal** 聚合（不按完成顺序）。sequential 的每步 effective input 与已完成结果提交后才派下一项；parallel 任意回执乱序仍只聚合一次。保留原 matcher/tool aliases/agentScope、完整配置去重和当前 source 顺序。固定 `sourceResolution='native-hook-fallback/1'`：复用当前 separated user/project 与 merged fallback 的计算，不另拼 system/default 组；每项同时记录真实 SourceStamp 和原 execution source tag。因此 system/default、缺省 user/project、空对象与 undefined、trusted/untrusted 的组合均保留原 effective plan，不会因来源“清理”改变执行次数。

| 事件                                              | 目标位置/顺序，必须保留的现有语义                                                                                                                                                                                                                                                 |
| ------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| SessionStart / InstructionsLoaded                 | 原逻辑 startup/resume/clear/compact 的 event occurrence；writer/owner 与 HookSystem/registry 就绪后、相关 context 消费前。`LlmClient.startChat:2167` SessionStart additionalContext 进入 chat。activation 重建不等一次新的用户 resume，不重复跑已提交 occurrence                  |
| UserPromptSubmit / UserPromptExpansion            | 原始提交与 slash 扩展分别触发；只有新的逻辑 occurrence 可运行。Hook 输出参与实际模型输入，submitted/display provenance 单独保留；阻断后不派模型，不能先 durable ACK 为模型已消费                                                                                                  |
| PermissionRequest / PermissionDenied → PreToolUse | ACP `Session:11906,12420` 的 permission gate 在 PreToolUse 前；Managed preflight 当前携带 worker Hook 回执。permission Hook 更新参数后重建/重校验 prepared input 与权限，不重用旧许可；PreToolUse 全通过、最终 guard 通过后才 execute                                             |
| PostToolUse / PostToolUseFailure → PostToolBatch  | ACP `Session:12820+` 以真实 native success/error/cancel 判定；物理工具完成与 Hook 失败分开记录；Runtime 已有 postHook 由 Harness 消费而不重跑。批次全部结算再 PostToolBatch。取消晚于 native success 不能篡改物理成功                                                             |
| MessageDisplay / Stop / StopFailure               | 保留显示流 occurrence 与终态事件区别、Stop 可要求 continuation/阻断、API 失败走 StopFailure。显示已发送与外部 Hook 完成分开记录，恢复不能重放整段流而再次发送同一副作用                                                                                                           |
| PreCompact / PostCompact                          | 压缩前策略→压缩结果提交→PostCompact；恢复引用压缩和 Hook 结果，不重新压缩/重复 Hook 来猜状态                                                                                                                                                                                      |
| SubagentStart / SubagentStop                      | 以稳定 child scope+creation/completion operationId 关联父子 receipt；不把父/子 Hook 注册合并成一个 Session 全局 map；child pending 阻止要求已完成的安全边界                                                                                                                       |
| TodoCreated / TodoCompleted                       | 沿原 HookPhase.validation 无副作用约定→Todo 原子提交→postWrite；validation/写入/postWrite receipt 独立，写后 Hook 失败不回滚已完成 Todo 或重复写                                                                                                                                  |
| Notification / SessionEnd / SessionDelete         | Notification 是独立 delivery occurrence。terminal close 在取消与工具/历史对账后、最终释放 Runtime/provider 和 writer 前发 End，并等 End 自身结果；detach 不发 End/Delete。显式 delete 后的 Hook 需要预备删除前只读 context，日志墓碑/receipt 保留，不能因历史已删除再拿不存在路径 |

命令 Hook 复用现有 process tree/TERM→KILL/wait/超时/output 算法；异步命令原语义是后台准入回执，**不是结果成功**，Runtime 持有 process/inflight lease 和最终结果。现有 MessageDisplay/StopFailure/SessionDelete surviving supervisor（`hookRunner.ts:1090+`）必须转为明确的 Runtime owned background binding；parent-independent 不得变成无 owner。取消/close drain 等真实退出后释放，不能仅清 AsyncHookRegistry。

HTTP 复用 allowedEnvVars、URL allowlist、DNS/private-host 政策与 timeout；新的显式 env 输入不能绕开这些。目标固定 redirect 策略为最多 5 次且每跳重新校验 scheme/URL/DNS/credential scope，禁止把当前自动 follow 当完整跨 host 授权。HTTP 已发出但结果未明不自动 retry。`once` 原实现按 URL+event、首次尝试前即消耗（`httpHookRunner.ts:154–169`），目标原子记录 once 消耗与 execution intent，失败也不自动恢复资格；不是“成功后一次”。

prompt Hook 沿原 model override failClosed、timeout、输出解析与 non_blocking_error 语义，返回 HookReceipt 的 orchestration 来源；模型 job 未 settled 时 Harness 驻留占槽，不标 durable_wait。未知模型、费用/权限拒绝与模型调用失败各返回现有事件适配应有的阻断/非阻断结果，不假装通过。

模型资格采用私有协议唯一 activation 的 subject 分型：`turn {turnId}` 或 `hook_operation {operationId,occurrenceId,event,phase,originTurnId?}`。已有有效 turn activation 内的 prompt Hook 绑定该 grant；无活 turn 或原 grant 已释放的 SessionEnd/SessionDelete/Notification/UserPromptExpansion 等合法 occurrence，由 authority 按已受理 Hook operation 领取 hook_operation activation，并填入 HookExecutionBinding.modelActivation。两种 subject 共享同一 Session 单调 epoch、唯一推进者、共享槽位与模型预算；Hook 用量关联 operation，并在有 originTurnId 时保留原 turn 归因，不复位原预算。

hook_operation 只调用已固定 plan 中的原 PromptHookRunner，不启动主 Agent、用户 turn、工具循环、Goal/cron 或初始化 Hook；没有资格时按原 operation/截止约束排队或返回明确不可执行结果，绝不借 OperationGrant 调模型。closing/deleting 只准入原维护操作合法的生命周期 occurrence，并在 Hook 结算前保留 writer/provider/模型凭据；其他新业务继续被封闭。authority 提交 model.attempt 与 domain.committed 的 hook_execution recordRef 后释放该 activation，不生成 turn.settled 或普通任务完成通知。SDK/function callback 不能利用这一 subject 发起未注册模型请求。

function Hook 只能通过预注册 `RegisteredHandlerRef {handlerId,codeVersion,owner,restoreCapability}` 重建；SDK callback 则绑定 client/host lease。未知 closure/无重连能力 handler 可以在原 host 驻留运行，但不得声明可 detach checkpoint；host 丢失返回 recovery_blocked(handler_unavailable)。onHookSuccess/messages context 同属 handler contract，不能只保存 callback 名字后丢掉这些回调副作用。

动态 add/remove、Skill 注册与 agent 限定注册提交第 7 节 `domain.committed` 的 hook_registration 记录引用，Hook catalog revision 单调；已开始 occurrence 固定旧 plan，remove 只停止未来匹配，旧 receipts 可结算。复用 Session 唯一 journal 的 registered hook execution 记录，不另外保存一套可独立写入的 Session 历史。command/HTTP 即使外部效应不明也有结算状态，不得为了允许恢复造成功。

## 7. 领域记录与协议一致性

本节七个 ExtensionDomain 与[存储 §3.1](managed-agent-session-storage.md#31-domain-注册索引)逐项对应；以本节定义正文，以存储索引校验完整名称集合。认识全部名称不提前启用 Skills/MCP/Hooks 或完整初始化，仍按各专项阶段与实际 capability 放行。

所有写入 Session 的扩展领域事实只使用存储规范已有的 `kind='domain.committed'`。event payload 只携带 domain/version/operationId/recordRef，详细输入、状态、输出和错误先存为受控内容资源；不增加 skill.activated、hook.executed 等竞争 event kind。`config.bound` 是原协议的配置绑定事件，与 config_install 领域提交在同一 Session 事务内产生；不在它内联第二份领域内容。workspace scope 的配置/初始化先保存在 workspace 控制 owner 的操作元数据中，返回 WorkspaceConfigCommitReceipt，不产生 Session 事件；后续 Session 绑定只引用该安装结果，不再复制安装历史。

```ts
type ExtensionDomain =
  | 'config_install'
  | 'workspace_initialization'
  | 'skill_activation'
  | 'mcp_configuration'
  | 'mcp_operation'
  | 'hook_registration'
  | 'hook_execution';
interface ExtensionDomainEventPayload {
  domain: ExtensionDomain;
  version: 1;
  operationId: string;
  recordRef: DurableRef;
}
```

| domain                   | recordRef 的内容 schema v1 / 生产者 / 校验                                                                                                                                              |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| config_install           | 操作 phase、原/新 bundleRef、sourceProofRef、OperationGrant 引用、stage/enable ACK refs；WorkspaceConfigurationController，通过 authority 条件提交；enabled phase 未提交不能投影 active |
| workspace_initialization | root/config revision、FileService/registry/context/curator/watch 各阶段、原 Runtime phase receipts、资源引用；受控初始化适配，不把读快照当初始化完成                                    |
| skill_activation         | SkillActivationReceipt、原入口 cause/args、原 model activation、permission/hook catalog revision 和 Runtime args phase receipts；Skill 领域适配；模型/slash 差异及原 ID 去重            |
| mcp_configuration        | source/overlay owner、server revision、连接 generation、discover 状态与原 acquire/release phase receipts；MCP 配置适配，禁止 Session overlay 写成 workspace 广播                        |
| mcp_operation            | resource_read/prompt_get 的 McpOperationBinding、原请求/结果 refs、settled/unknown；可信 MCP Runtime 回执适配；tool_call 另走 tool.receipt，不以此旁路权限与物理结算                    |
| hook_registration        | 原 registration operation、来源、catalog revision、add/remove、descriptor refs、once 状态与 owner lease；Hook 领域适配，必须能重建当前计划                                              |
| hook_execution           | plan/binding、原 input revision、执行 phase/ordinal、Runtime/model/handler receipt ref、aggregate ref；可信各执行域回执汇合入口，不接受 Harness 自报命令已退出                          |

每种 recordRef 的 kind 固定为 `managed-<domain>`，schemaVersion=1；validator 按 domain 核对 kind/schema/归属/摘要/引用闭包及合法状态转换，不开放任意 JSON 内容。领域 operationId 幂等范围与原 CommandMeta 一致。物理工作开始前提交 intent/phase，之后按原 RuntimeReceiptStore 与 coordinator 查询，不因领域 record 缺失重做。不同来源 ToolOutcomeRef 仍受可信定义限制；领域回执不能代替 Runtime gate/物理结果。

配置/Skill/Hook 注册续存于 checkpoint 的 config/definition 和后续工作引用；Hook/MCP 未决调用续存于原 invocation/operation 与 scope lineage。A/D 需要本轮结果和引用闭包完成；B/C 只有 waiter 与原 Runtime/operation owner 已转交才可 detach。prompt Hook 模型请求或不可恢复 callback 活跃时继续驻留；配置维护 grant 不增加新的安全点。

所有新 control/event/资源采用存储规范的 8 MiB/1 MiB/256 项/深度 64 和分片规则，旧 MCP/Hook/Skill 输入输出的合法总量不因内部 envelope 缩小而丢失。catalog 列表分页并固定 revision，跨页 revision 改变返回 conflict 后重读；大正文、资源、prompt messages 用完整 refs。错误使用私有协议类别，具体配置原因放有界 errorRef（例如 source_changed、credential_required、handler_unavailable），不随意增加不受验证的顶层错误枚举。

## 8. 实施顺序与验收 E01–E07

C03 根与严格读取进入 R2.1/2.2；完整初始化/Skills 属 R5.F1，MCP 属 R5.F4，Hooks 属 R5.F5。先根/版本 gate，再初始化/Skills，之后 MCP，最后完整 Hook 分派与事件回执。各域契约已在本文确定，实施按片验证后再扩大 selector 的支持证明，不提前取消首阶段延期规则。

| 编号 | 能力与必须通过的场景                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| ---- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| E01  | C03 来源/根/凭据：两 workspace 不同 QWEN_HOME/runtime/system roots、dotenv/env/argv、trust；selector/bootstrap/new/load/resume/worker/reload 读取同一有效根；nearest dotenv/home redirect/baseEnv 空值/excluded keys/merge precedence；错误根与凭据 audience 被拒绝，无 process.env/cwd 污染。纯 probe 无目录/迁移/连接/Hook；缺省正常，损坏/unknown version/非普通文件/dangling symlink/读时删换拒绝，不降格为空                                                                                         |
| E02  | C03 初始化/版本：writer/owner 错误在 Goal/curator/cache/watch 前拒绝；source stage 失败保留旧版，commit 后 ACK 丢失可查原结果；无Session workspace安装返回Workspace receipt且不造Session；跨 Session 逐个绑定可观察而不假称原子；ConfigInstall 不重开旧 epoch；旧 invocation 固定原版，撤信任封新派发，旧 generation cleanup 可达；parent/child 不借 primary Config，恢复不重复 init 副作用                                                                                                               |
| E03  | C07 Skills/指令：context/rules/extension 与 InstructionsLoaded 次数、project>user>extension>bundled、name排序/priority、safe/bare、disabled、paths、model/slash 差异；合法外部软链/远端无挂载、发现后换文件、重复加载、模型/UI/校验同 revision；权限/Hook/模型选择与 args 写入/撤销的前后崩溃恢复均不复用旧 authority 或重复副作用                                                                                                                                                                        |
| E04  | C08 来源/发现：defaults/user/project/system/session/CLI/extensions/runtime/client 冲突和 shadow/remove、allow/excluded/pending；pending 连 lazy resource spawn 也拒绝；stdio/HTTP/SSE/SDK、resource-only/prompt-only、合法空与 partial failure、catalog分页/blob/多消息prompt；旧通知不改新版，client lease 不跨会话借用                                                                                                                                                                                  |
| E05  | C08 生命周期：legacy/Managed 共用总预算和 process owner、同名替换新旧 generation、OAuth过期/错误账号、SDK失联、重发现仅影响新调用；cancel 后迟到成功、远端 outcome_unknown、不重放 guarded call、HTTP终止 DELETE超时、close/reload全drain；所有 phase/ACK窗口恢复查询原调用，无假成功或提前释放                                                                                                                                                                                                           |
| E06  | C09 来源/时序：system-only/default-only、user present/project absent、空对象/undefined/trust 的 merged fallback 矩阵与原生次数一致；extension/skill/agent/SDK注册、四种runner、parallel乱序/sequential变参、permission重校验、Pre拒绝未执行/Post失败工具已成功/PostToolBatch只一次；完整触发矩阵、Todo validation/postWrite、parent/child隔离和外部旧返回保持                                                                                                                                             |
| E07  | C09 取消/恢复：intent/Runtime结果/Session ACK各窗口丢失，once 首次失败后恢复不重试，async surviving process实际退出，HTTP已发结果未知，prompt Hook计费与流中detach拒绝，function handler失联blocked；无活turn的End/Delete/Notification/Expansion使用hook_operation，与turn竞争时唯一epoch/槽位且不生成用户turn/任务通知，不重跑init/Goal；activation recovery不重复startup/resume/Stop/End；detach不发End，close等End结果后释放，Delete墓碑可结算；HTTP重定向每跳策略、env/凭据脱敏、旧清理权限无新派发权 |

通过条件包括原入口行为、协议回执、物理进程/文件/网络副作用、Session 记录和最后清理的对应证据；单元测试或 catalog 能展示不能单独证明迁移完成。新增接口必须接到真实生产者/消费者后才记为实现，验收表存在不代表产品已通过。
