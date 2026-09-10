# Daemon 工作区运行时拓展

[English](daemon-workspace-runtime-extensions.md) | [简体中文](daemon-workspace-runtime-extensions.zh-CN.md)

## 目标

将拓展管理迁移到工作区所属运行时，无需创建聊天 session。现有 Extension Store
继续作为全局持久化所有者，仅实时目录和协调刷新使用选定运行时。

## 所有权

- `GET /extensions` 是 daemon 本地的全局制品目录。
- `GET /workspaces/:workspace/extensions` 是一个工作区的持久化激活投影。
- `GET /workspaces/:workspace/runtime/extensions` 返回选定运行时的实时目录和 epoch。
- `WorkspaceRuntimeCoordinator` 拥有期望/已应用 generation、能力就绪态、运行时刷新及过期结果拒绝。
- 全局变更使所有受管理运行时失效；工作区激活和资源状态变更只使选定运行时失效。

协调器是拓展运行时就绪态的唯一可写所有者。路由控制器仍拥有操作历史和持久化变更
排序，并将已提交 generation 通知受影响协调器。

## 协调刷新

Extension Store 提交成功即表示拓展变更成功。对受影响且可信的活动运行时，协调器
刷新 bootstrap 配置、发现配置及活动 session，然后读取实时目录。只有响应来自当前
epoch，且已应用 generation 等于最新期望 generation，能力才标记为 ready。
冷运行时保持 deferred，等下次 `ensureRuntime()` 再生效。

只有 ensure 启动冷运行时；排队后的协调刷新重新检查存活状态，不执行 preheat。
已应用 generation 的认证属于特定 epoch，窄范围 Skill 刷新不能跨 epoch 继承认证。
过时 generation 返回 `superseded`，不算刷新失败。drain 延后任务保留窄/完整范围，
两者同时待处理时完整刷新优先。冷却结束后再次失败会重新开始冷却。

观察到新 generation 时，即使运行时是冷的，也使保留的 Skill 快照失效。
投影 generation 相等不独立代表就绪，还需当前 epoch 和协调器能力状态。
轮询器的新鲜权威读取支持存储恢复到较低 generation：清除已应用认证并推进协调器 revision。
读取期间若观察到其他变更，则该读取不能降低 generation；仅操作回执始终不能降低 generation。

拓展应用还会使选定运行时的 Skills 和 MCP 能力失效，因为两个目录均包含拓展贡献。
来自已替换运行时的迟到刷新或目录响应不能推进就绪态。

## API 与 SDK

运行时状态增加 `extensions` 能力，包含 `state`、`revision`、`runtimeEpoch`、
`desiredGeneration`、`appliedGeneration`。实时拓展目录响应增加 `runtimeEpoch`。

`WorkspaceDaemonClient` 提供实时目录。全局安装、更新、卸载、更新检查、默认激活
保留在 `DaemonClient`；工作区激活、拓展 Skill 状态、投影和实时目录读取保留在
`WorkspaceDaemonClient`。

来源安装使用 V2 全局路由。V2 归档端点存在之前，归档上传仍走旧工作区路由，保留旧的
默认激活行为。

交互安装和更新共用 `/workspace/extensions/operations` 下现有的交互应答端点。
准备阶段截止时间取消待输入交互。已准备资源由路由持有，直到其 `finally` 释放，
包括截止时间阻止提交的情况。

## Web Shell

daemon 声明 `workspace_extensions_config_runtime` 时，拓展页面：

1. 读取全局目录和选定工作区投影，不启动 ACP；
2. 调用共享的无参数运行时 ensure；
3. 当持久目录 generation 与协调器可用、实时目录已初始化、能力和目录 epoch 均匹配
   协调器 epoch 时，合并实时详情及 `isActive`。能力就绪及能力/投影的期望与已应用
   generation 相等决定是否重新读取目录和投影，不决定是否保留 epoch 匹配的实时行；
4. 列表页显示工作区选择器，详情页显示禁用的选择器。

旧 daemon 保留现有主工作区流程。

daemon 同时声明 `workspace_extension_mentions` 时，输入区 `+` 和 `@` 拓展菜单
使用选定工作区运行时；否则保留旧主工作区加载器。

提示归属和进行中操作锁互相独立：未知或缺失的拓展名称回退到全局提示区域，但不释放
活动操作的锁。

## 验证

覆盖冷/排队后变冷运行时、过时 generation、运行时替换、同 epoch 窄刷新、drain
回放、连续失败冷却、保留 Skills 失效、交互准备超时及恢复操作提示。
执行现有本地安装集成测试，确认不启动 ACP child。

## 下游消费者

- 运行时状态和工作区管理路由；
- 拓展 V2 操作协调及外部 generation 轮询；
- Skills 与 MCP 能力失效；
- TypeScript daemon SDK；
- Web Shell Plugin 管理器和拓展管理器。
