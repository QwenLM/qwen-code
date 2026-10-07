# Web Shell Session 自动创建 Worktree

[English](2026-10-07-web-shell-automatic-worktree-session.md) | [简体中文](2026-10-07-web-shell-automatic-worktree-session.zh-CN.md)

## 问题与当前行为

空会话输入框目前需要先选择 Worktree，再点击“创建 Worktree”。这次确认只记录
草稿意图，并不创建工作目录。发送首条消息时，现有流程已经通过 `POST /session`
携带 `worktree: {}`，自动生成名称、创建并进入 Worktree。
这次确认容易让用户误以为需要单独完成准备步骤。

侧边栏与 Worktrees 管理界面已经支持直接进入 Worktree 草稿。

## 改动方案

在 `GitModePopover` 中点击 Worktree 后，立即记录现有的
`{ mode: 'worktree' }` 意图并关闭弹层，与选择当前分支的行为一致。
说明文案明确指出：发送首条消息时自动创建独立副本。
移除多余的确认按钮及其不再使用的样式和翻译。

输入框的模式标签展示选择结果。发送前，用户仍可通过现有重置按钮回到当前分支。
仅选择 Worktree 不发送创建会话请求，也不创建文件。
首条消息沿用现有链路将意图传给 daemon，由 daemon 自动命名 Worktree。

## 范围与约束

仅修改 Web Shell 模式选择器、样式、中英文文案及浏览器测试。
沿用现有可用性判断、工作区意图重置、会话创建、所有权、失败处理和清理行为。
不新增设置、API 字段或名称输入，也不默认隔离普通会话。
新建分支模式仍需输入名称并确认。

不需要修改 daemon 路由或 core 模块。

## 验证与验收标准

- 点击一次 Worktree 即选中并关闭弹层，无需二次确认或命名。
- 仅选择模式不创建会话。发送首条消息时，仅发送一次 `POST /session`，
  请求含 `worktree: {}`，不含 `branch`。
- 发送前重置 Worktree 草稿后，创建普通会话。
- 现有分支选择、默认模式和非 Git 工作区可用性测试通过。
- 运行相关单元测试和浏览器测试，以及 build、typecheck、bundle。
  在 `.qwen/e2e-tests/` 记录基线和验证结果。

## 风险与开放问题

移除模式选择确认后，需要保持误选在发送前可撤销。
现有重置控件已提供这一能力。没有未决设计问题。
