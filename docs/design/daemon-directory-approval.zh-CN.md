# Daemon 目录审批

[English](daemon-directory-approval.md) | [简体中文](daemon-directory-approval.zh-CN.md)

## 问题

普通 daemon 工具调用已经经过 core 权限流程，但内建 Git guard 随后仍无条件拒绝外部目录。用户批准的调用和 Full Access 都会失败。原始报告还遇到了 Shell 和 Monitor 提前拒绝外部 `directory` 参数的问题；这一部分现已由 [#12927](https://github.com/QwenLM/qwen-code/pull/12927) 解决并合入 main。本次补齐 daemon 侧的处理。

## 决策

复用现有权限，不增加另一套审批机制。Shell 和 Monitor 对外部工作目录请求权限，并显示工作区外执行警告。是否执行由既有权限规则和审批模式决定。执行沙箱和用户 skills 目录限制保持不变。

Core scheduler 和 ACP Session 在正常准入及 PreToolUse 处理后，为最终 guard 调用设置 `permissionChecked: true`。Core 的 `fixed_policy` 调用跳过这套权限流程，因此携带 `false`；它们仍经过 host guard，也不会新增确认步骤。Managed ACP adapter 将这个运行时字段与模型参数分开传递。BridgeClient 校验其类型及会话、prompt 归属。

Daemon 仍校验上报的 invocation 执行范围；对经过正常权限流程准入、且在会话自身目录中执行的调用，跳过额外的目录/Git 范围检查。被固定到自身 worktree 的 sub-agent 即使已准入也保留该范围检查：worktree 边界是阻止它触及兄弟 worktree 和父 checkout 的唯一机制，权限流程不会重建这条边界，Full Access 下也没有其他环节会这样做。强制外部 provider 仍检查最终调用，并且可以拒绝。Speculation 不设置该字段，保留现有范围 guard。Managed Runtime 工具执行不经过正常权限流程，因此其 executor 在构建 shell 调用时保留显式的工作区目录准入检查。

## 约束

本设计定义当前的批准后策略，取代[原始 Git guard 设计（英文）](daemon-git-worktree-guard.md)中无条件拒绝的规定。旧文档保留为历史参考，说明未改变的解析器，以及未经正常权限准入的 shell 调用所使用的兜底范围检查；它不代表对正常准入调用的第二次否决。该字段表达调用来源，不是 OS 凭证或模型自行授予的能力。同机、同 UID 的信任模型不变。缺少字段时保留此前的 guard 行为。外部 provider 的 HTTP 协议不变。

显式 deny 规则、用户取消、hooks、沙箱限制及强制宿主策略继续生效。不引入 worktree 特例、新配置、审批 UI、授权 token 或通用 shell 解析器。

## 验证

- 普通模式：批准外部 shell/monitor 工作目录及跨目录 Git 调用后，观察真实执行；拒绝时不启动命令。
- Full Access：同样的调用无需普通确认即可执行。
- 显式 deny 及拒绝调用的外部 provider 仍阻止执行。
- 沙箱不允许的目录及未获准的 Managed Runtime 调用仍被拒绝。
- Core scheduler、ACP Session 和 bridge 测试固定运行时标记的传递；模型参数中的同名字段不会授予权限。
- 固定策略调用携带 `false`，普通调用携带 `true`；host 的允许/拒绝仍决定是否开始执行。
- 无标记的调用及无法验证的 invocation 范围保留原有 guard。
- 设置标记后，固定到 worktree 的 sub-agent 仍被限制在该 worktree 内；会话的普通子目录与会话根目录一样获得准入。

已使用全局 CLI 和两个临时仓库复现基线。报告修复通过前，使用修复后的 bundle 重跑同样的 daemon E2E 用例，并运行定向单元测试、build 和 typecheck。
