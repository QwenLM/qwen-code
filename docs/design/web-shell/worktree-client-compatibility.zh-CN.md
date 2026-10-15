# Worktree 客户端兼容性

[English](worktree-client-compatibility.md) |
[简体中文](worktree-client-compatibility.zh-CN.md)

## 范围

本补充设计处理
[PR #11816 验证报告](https://github.com/QwenLM/qwen-code/pull/11816#issuecomment-5851912768)
中的 F1 和 F2，替代
[可选 worktree 设计](web-shell-branch-session-optional-worktree.md)
第 6.2、7.1 节关于缺失 session id 的规则。分支事务与 worktree 生命周期不在本次修复范围内。

## 决策

当已发布的分支无法激活 worktree 时，Web Shell action 重新抛出原始错误，不派发通用失败通知。
App 负责显示恢复提示并刷新源会话目录。其他错误，包括发布结果不确定的情况，继续派发通用通知。

旧 Web Shell 客户端发送 managed worktree 的 `cwd` 时不带 `sessionId`。
仅当查询字段缺失时，daemon 从 managed worktree 根目录的 `.qwen-session` marker
读取候选 session id，读取须满足文件大小限制且为普通文件。marker 只提供查找线索，不能单独授权。
显式传入非法或不匹配的 id 时直接拒绝，不尝试推断。

候选 id 必须通过现有授权检查：所选 runtime 的 live snapshot、匹配的 workspace
归属、匹配的持久 sidecar、匹配的 marker、canonical managed root 包含关系、相同的
Git common directory，以及有效的 Git directory backpointer。
cwd 指向 worktree 内子目录时，使用所属 managed worktree 根目录的 marker。
任何失败都不能回落到 primary workspace，也不能授权另一个 checkout。

这些路由仍由所选 runtime 管辖，并校验 live session 归属。同一 resolver 覆盖
status、diff/file diff、log/commit detail、branch listing、checkout、branch
creation、push、pull、commit，以及 GitHub PR creation。Trust、runtime generation、
environment 和 mutation admission 保留现有检查。新客户端继续显式传入 owner id。

## 验收标准

- 激活失败恰好显示一条恢复提示；普通错误和 outcome-unknown 错误仍显示通用通知。
- 旧式只传 `cwd` 的请求可访问有效的 live managed worktree 及其子目录，不能扩大到其他仓库目录。
- 显式错误、非法、空值或重复 id 均被拒绝。缺失、非法、符号链接或归属不匹配的 marker
  均被拒绝；live owner 不可用、runtime 错误、sidecar 无效或 Git directory 不匹配同样拒绝。
- 读取与修改路径使用相同的 owner 推断和校验。
- 定向回归测试在原 PR head 上失败、修复后通过；执行构建、类型检查及包内测试验证改动。
