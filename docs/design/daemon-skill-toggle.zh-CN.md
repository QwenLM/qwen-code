# 守护进程 Skill 切换

[English](daemon-skill-toggle.md) | [简体中文](daemon-skill-toggle.zh-CN.md)

## 目标

通过守护进程 REST 和 TypeScript SDK 写入工作区 Skill 设置，并立即刷新活跃的 ACP 会话。运行时 Skill 目录为启用保护提供身份信息，但不限制哪些名称可以被持久化。

## 公共契约

- `POST /workspace/skills/:name/enable`
- `POST /workspaces/:workspace/skills/:name/enable`
- 请求体：`{ "enabled": boolean }`
- SDK：`DaemonClient.setWorkspaceSkillEnabled` 和 `WorkspaceDaemonClient.setWorkspaceSkillEnabled`
- 能力：`workspace_skill_settings_toggle`

响应包含去除首尾空白后的请求名称、请求状态、持久化是否发生变化、激活状态以及会话刷新数量。`activation` 独立于 `changed` 反映子进程存活状态和所需刷新：`applied` 表示子进程存活且所需刷新成功，`deferred` 表示在存活检查时没有子进程，或已变更的请求在所需刷新期间失去子进程或会话，`partial` 表示持久化提交后至少有一个其他所需刷新失败。因此，无操作请求的 `changed` 仍为 false，而 `activation` 可以是 `applied` 或 `deferred`。

## 语义

API 按名称修改工作区的 `skills.disabled` 和 `skills.enabled`，但不要求该名称存在于运行时 Skill 目录中。启用默认禁用的 Skill 会写入显式选择加入；禁用会移除选择加入并写入工作区硬禁用。更新一个目标会移除其重复项和大小写变体，但不会删除不可用 Skill 的孤立条目。名称可以在安装前、对用户调用隐藏时或所属 Extension 未激活时被禁用。启用会移除已有的工作区禁用，或为有效的 `skills.defaultDisabled` 条目记录选择加入。已有的工作区 `skills.enabled` 声明会被保留，并规范为请求中的大小写。若既没有工作区声明，也没有有效的 `skills.defaultDisabled` 条目，则启用是无操作（`changed: false`）。第二次相同请求同样是无操作。

在评估启用保护前，持久化闭包会为整个单项或批量请求读取一次工作区 Skill 状态。目录中带有 `level: 'extension'` 和 `extensionName` 的条目同时提供注册名称，以及去掉已知扩展前缀后的创作名称；其他层级的条目只有注册名称。未知名称、未初始化的状态或失败的状态读取都会回退到此前依据标点推导别名的行为。该回退保留了不可用扩展 Skill 的旧式裸名称阻止语义。没有活跃 ACP 子进程提供目录时，守护进程本地状态会省略扩展 Skill，因此在本地扩展枚举可用之前，这些名称仍走回退路径。禁用操作不读取目录。

批量启用会根据不断演进的最终工作区列表，反复重新考虑先前被拒绝的名称，直到列表不再变化或所有名称都有结果。该不动点计算使结果不受请求顺序影响，包括多步旧式别名链，同时仍只写入一次设置。

从更高作用域继承的硬 `skills.disabled` 条目仍决定有效可用性，但不会阻止工作区作用域记录或移除自己的声明。其他工作区声明按照通常的 `skills.disabled > skills.enabled > skills.defaultDisabled` 规则参与解析，并可覆盖更高作用域的 `skills.defaultDisabled` 或 `skills.enabled` 条目。路由保留请求形状、认证、客户端身份、工作区信任和运行时世代保护。目录身份解析位于持久化闭包内部，不增加路由级验证。

工作区的读取、修改和写入在守护进程的逐工作区设置锁内完成。写入失败会在刷新和事件发布前停止。

## Skill 可用性与 `disable-model-invocation`

`skills.disabled` 是运维人员的硬拒绝列表，会跨作用域按不区分大小写的并集合并。`skills.defaultDisabled` 提供可覆盖的默认值，`skills.enabled` 提供显式选择加入，优先级为 `disabled > enabled > defaultDisabled`。有效禁用会移除匹配的 Skill 斜杠命令和模型可见的 Skill 条目，执行时验证也会拒绝该 Skill。守护进程端点写入 `disabled` 和 `enabled` 的工作区成员。

`disable-model-invocation` 是 SKILL.md 元数据。它对模型隐藏 Skill，但保留用户直接调用。现有的托管 Skill ACP 操作编辑该元数据，本 API 有意不复用它。

## 激活流程

1. 验证请求名称、授权、工作区信任、客户端身份和运行时世代。
2. 在工作区设置锁内，通过一次目录读取解析启用身份，重新读取所有作用域，计算最终的工作区声明变更，并最多提交一次写入。
3. 若声明没有变化，返回 `changed: false`，且不进行缓存失效、刷新或事件发布。
4. 否则，使守护进程缓存的 Skill 状态失效。
5. 若 ACP 子进程存活，调用 `qwen/control/workspace/skills/refresh`。
6. 子进程重新加载工作区作用域设置，并刷新所有活跃会话，包括忙碌会话。
7. 每个会话重新加载自己的工作区设置，重建并推送 `available_commands_update`，并通知 SkillManager 使用方。
8. 为每个变更的 Skill 设置键发布现有的工作区 `settings_changed` 事件。

进行中的模型请求无法被改写。后续 Skill 执行检查、命令快照和模型上下文会读取新状态。

## 下游使用方

- 设置合并：系统默认、用户、工作区和系统列表以 `disabled > enabled > defaultDisabled` 的优先级形成有效的禁用名称集合。
- 工作区状态：ACP 和守护进程本地 Skill 映射公开禁用状态、禁用原因、锁定作用域和仅在为 false 时出现的 `userInvocable`。
- 斜杠命令：可用命令构建会移除禁用 Skill，并向守护进程客户端发送更新后的命令元数据。
- 模型上下文：SkillManager 变更监听器会刷新 Skill 工具描述和可用 Skill 上下文。
- 执行验证：Skill 工具在调用前重新读取禁用名称提供方，因此后续调用会被立即拒绝。
- 扩展状态：未激活的 Extension 仍使其 Skill 在运行时不可用，这与工作区设置是否记录这些名称无关。
- 守护进程缓存：持久化后会使缓存的活跃子进程 Skill 快照失效，防止后续 GET 请求重放过期状态。
- SDK 使用方：主工作区客户端和工作区限定客户端共享仅包含设置结果的响应契约。
- 事件：现有的 `settings_changed` 使用方会观察每个已提交的 `skills.disabled` 或 `skills.enabled` 值；不新增事件类型。

## 失败行为

- 持久化失败：HTTP 请求失败；不进行 ACP 刷新，也不发布事件。
- 启用期间无法读取 Skill 状态：持久化使用旧式的标点推导别名并继续；请求不会以失败关闭。
- 声明变更后没有子进程：持久化成功并返回 `deferred`；下一个子进程会在启动时加载设置。
- 声明没有变化：响应报告 `changed: false`；不进行刷新或事件发布。`activation` 仍反映子进程是否存活，但无需激活工作。
- 单会话刷新失败：持久化保持已提交；成功的会话保持已刷新，响应为 `partial`。
- 子进程传输竞态：若子进程在存活检查后消失，响应为 `deferred`；其他刷新失败报告为 `partial`。
