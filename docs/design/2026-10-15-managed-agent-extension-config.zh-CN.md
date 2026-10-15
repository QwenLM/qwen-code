# Managed Agent 扩展配置与静态 Skill

[English](2026-10-15-managed-agent-extension-config.md) | [简体中文](2026-10-15-managed-agent-extension-config.zh-CN.md)

状态：已实现并完成本地验证。基线：`e612bbf23c`。

## 问题与基线行为

Managed MCP 和 Hook 已有可持久恢复的私有 Hosted 实现。公开 AgentDefinition 可以保存 `skills` 和 `mcp_servers`，但创建 Session 时拒绝非空值。Hook catalog 尚无 AgentDefinition 字段。Hosted 有意跳过本地 SkillManager，防止 Harness 主机安装的技能泄漏到远端 Session。

本次把显式发布的扩展接到已有 Session 定义上。Harness 仍是唯一模型驱动者，MCP 凭据、Hook recipe、命令执行和 Workspace 文件仍属于 Tool Runtime。

## 范围与配置

首个支持的 Skill 是模型可调用的静态指令资源。AgentDefinition 发布名称、描述和 Markdown 正文。不可变的 AgentDefinition revision 固定这些字节，修改定义只影响新 Session。Skill 可以指定相对 Session 在 Workspace 内保存的工作目录的基目录，与已有文件工具的路径契约一致。Harness 绝不把这个目录当作自身主机上的路径。脚本和附件仍是 Workspace 资源，通过选定 Runtime 的既有工具和审批策略访问。

MCP 定义只包含 `server_id`、`server_revision` 和 `definition_digest` pin，用于选择管理员预置的 Runtime manifest。它要求既有 MCP 工具 profile 和部署白名单。Hook catalog 同样只包含 `catalog_id`、`catalog_revision` 和 `definition_digest`，要求绑定 Workspace 的工具 profile。这两个受支持的 pin 形状都不接受 endpoint、凭据、命令、模块路径或执行 recipe。

Skill 要求绑定 Workspace 的工具 profile，不初始化本地 SkillManager 发现。扩展字段为空或省略时保留原行为。非法、重复、超限、不兼容或尚不支持的定义，在准入时返回明确指出字段的错误。非空 MCP pin 没有搭配 MCP profile，以及 MCP profile 没有提供 pin，均拒绝。

每项 Skill 只接受 `name`、`description`、`body` 和可选的 `base_directory`（默认 `.`）。名称沿用原生 Skill 字符集合，上限为 128 UTF-8 字节。一个 catalog 最多包含 16 个不同名称，JSON 总量不超过 48 KiB；描述上限 4 KiB，正文上限 32 KiB。目录上限 4 KiB，使用规范相对 POSIX 分段，不允许目录穿越、反斜杠、冒号或控制字符。拒绝非法 Unicode 和必填字段的空白值，同时不改写已发布正文的字节。

```json
{
  "skills": [
    {
      "name": "repository-review",
      "description": "Review changes using the project's review guide.",
      "body": "Read review-guide.md and apply its checklist to the current diff.",
      "base_directory": "docs"
    }
  ],
  "mcp_servers": [
    {
      "server_id": "repository-tools",
      "server_revision": 1,
      "definition_digest": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
    }
  ],
  "hook_catalog": {
    "catalog_id": "repository-policy",
    "catalog_revision": 1,
    "definition_digest": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
  }
}
```

这些字段属于一份其他部分合法的 AgentDefinition。这个组合示例要求其 `tools` 字段选择部署白名单中的 MCP profile。

## 归属与执行

| 组件                           | 职责                                                                                                                          |
| ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------- |
| Java 控制面                    | 校验已支持的配置，创建 Session 时固定 AgentDefinition revision/digest，在创建 Hosted attachment 时发布不可变 Skill 内容资源。 |
| Hosted Session                 | 把 Skill 引用、MCP server pin 和 Hook catalog pin 保存在 `managed-definition` 中；从保存值恢复，并拒绝冲突请求。              |
| Harness                        | 展示显式 Skill catalog 和 `skill` 工具。把选定的不可变正文加载到工具响应中，不访问本地文件系统。沿用已有 MCP 和 Hook 编排。   |
| Runtime Broker 与 Tool Runtime | 保持既有认证 Session 路由、Workspace 所有权、MCP 连接和凭据管理、Hook 执行以及回执和排空语义。                                |

Skill 工具使用已有 assistant/tool-result 日志。加载不可变指令没有外部副作用，也不授予权限。成功响应在下一次模型请求前提交。恢复可以复用已提交响应，或从同一不可变资源重新计算；它不能执行脚本、安装 Hook、切换模型或授予工具权限。对于这个仅加载指令的受限操作，无须新建 `skill_activation` 状态机。

Skill 调用受独立 Hook catalog 约束时，恢复读取原先已提交的 PreToolUse 聚合回执，保留其拒绝或有效输入。Hook 结果缺失或尚未结算时阻塞恢复。仅加载指令的 Skill 不创建审批等待；PreToolUse 返回 `ask` 时明确拒绝不支持的审批要求，不能自动授权。继续模型前仍执行已有后置工具 Hook 恢复。

Skill 发现和校验使用同一份已保存的 catalog。不在清单中的技能和不支持的参数均拒绝。正文和结果信封必须符合已有 Session Store 限制。Skill 描述有界，工具名称不能覆盖内置工具。附件相对路径从选定 Workspace 内 Session 保存的工作目录解析，配置准入时拒绝绝对路径、目录穿越和有歧义的根。

Skill 在独立工具批次中先加载，再执行 Workspace 工具。混合批次在 PermissionRequest Hook、审批 Action 或 Workspace 工具派发前被拒绝，避免静态指令读取进入既有仅支持文件工具的审批续行格式。恢复也从原 assistant 批次推导同一拒绝。既有 Session 初始化和 PostToolBatch Hook 保持原有行为。纯 Skill 批次可以加载多个技能。

## 恢复、生命周期与发布

既有 AgentDefinition revision 和 digest 仍是公开身份来源。Load 请求携带原身份，并使用已保存资源引用，不解析最新定义。Harness 替换后，Skill 通过持久内容引用保留。资源缺失或损坏会阻塞加载，不能静默丢弃技能。

MCP 和 Hook 副作用保留原稳定 operation ID 与 Runtime owner。结果未知时只观察原操作，不作为新工作重发。既有 MCP/Hook 的关闭和排空检查仍为必要条件。启用 MCP profile 仍要求部署显式配置 profile 白名单，并声明兼容 Hosted 生命周期能力；本次不全局启用，也不绕过升级门禁。

先部署兼容的 Harness 和 Runtime，再准入带新配置的 Session。没有扩展字段的已有 Session 保持可读。旧 Harness 可能拒绝新发布的配置，因此准入失败必须可见，不能被报告为安装成功。

## 边界

这是首条静态发布 Skill 路径。不实现 project/user/extension 文件系统发现、动态 catalog、slash 命令、路径触发激活、Skill `allowedTools`、Skill 注册 Hook、模型覆盖或参数文件展开。这些需要更完整的 C07 激活契约，目前明确拒绝而非静默忽略。AgentDefinition 显式 Hook catalog 独立于 Skill 激活。本次不增加 Environment 模板、包安装器、凭据 API、Runtime 共享或空闲回收策略。

## 涉及范围与验证

变更覆盖 AgentDefinition 校验和 OpenAPI schema、Java Hosted connector、不可变 Hosted 定义解析与加载，以及 Hosted Skill 工具。复用既有 MCP/Hook 实现。

实现前先在全局 CLI 确认基线，并区分公开准入缺口与普通 CLI 已有的 Skill 能力。测试合法及非法定义、资源发布、首次调用 Skill、未知 Skill 拒绝、资源损坏、冲突 load、Harness detach/load、MCP/Hook pin 转发以及 MCP 关闭能力门禁。使用确定性模型与 MCP fixture，证明模型看见并调用选定能力且不发现宿主 settings。运行定向 TypeScript 与 Java 测试、build/typecheck/bundle、适用的 Java 验证 profile，以及两轮完整 diff 自审。如实记录无法运行的物理环境，不能把 fixture 结果当作生产验收。

本地 build、typecheck、bundle、lint 和格式检查通过；另通过 515 项 Hosted Session 测试、337 项 Skill/Hook/工具/恢复测试、50 项模型/定义测试、77 项 Java SDK 测试，以及 Java server 验证套件（2897 项，跳过七项）。选定的 Hosted Harness/MySQL 8.4 profile 两项测试均使用最终 bundle 通过。MySQL 全量 profile 首次通过 548/549，既有异步校验时序用例在隔离重跑中通过；这不能把原全量结果记为全绿。

最终打包进程 fixture 完成 18 次确定性模型请求，逐项核对实际调用名称、参数与持久历史。它覆盖按需加载、非法调用、不可变冷加载、资源损坏或缺失、普通混批拒绝，以及纯 Skill 的 SIGKILL 后 HTTP 恢复。混批 SIGKILL 的 load 仍明确阻塞并返回 HTTP 409；另外在同一真实日志上调用已构建的恢复 helper，验证同一拒绝与幂等性，不能声称 HTTP 已续行。该 fixture 没有执行 Runtime 工具。这些结果不代表物理 Linux 执行、真实 MCP/Hook 副作用或生产验收。

## 验收标准

1. 新 Managed Session 能看到并调用已发布的静态 Skill，其正文进入持久模型历史。
2. 即使发布了更新的 AgentDefinition revision，重新加载原 Session 仍保留原 Skill 字节与扩展 pin。
3. 显式准入的 MCP 配置和 Hook catalog 到达既有 Runtime 实现，且不暴露 recipe 或凭据。
4. 未支持的选项、缺失资源、profile 不兼容以及冲突 pin，在受影响的工作执行前明确失败。
5. 回归检查覆盖已有 Session，以及其审批、恢复、关闭和排空行为。

## 开放问题

本受限切片没有待定问题。动态 Skill 激活和发现按既有配置设计另行推进。
