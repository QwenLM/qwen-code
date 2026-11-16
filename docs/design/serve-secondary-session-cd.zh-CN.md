# 次级工作区的会话 cd

[English](serve-secondary-session-cd.md) | [简体中文](serve-secondary-session-cd.zh-CN.md)

## 问题与范围

Issue #15316 希望普通会话使用独立目录，而不新增工作区注册，也不要求 Git。
现有 `POST /session/:id/cd` 已能切换单个会话的执行目录，但 legacy-primary
路由限制会拒绝动态注册工作区持有的会话。

选定方案复用该操作，不新增 Session 根目录设置、create/load 字段、工作区注册、
目录创建或文件迁移。保留现有指令与 skills 刷新语义；本次不引入单独固定的配置根目录。

## 路由与目录限制

将 cd 归类为 **live-session-owner** 作用域。通过现有的归属、信任和 generation
门禁解析持有会话的 runtime，只调用该 runtime 的 bridge。归属未知、歧义、不可信或
不可用时，绝不回退到 primary bridge。保留现有归档与 generation 门禁。

对次级工作区，由服务端提供只包含其 canonical workspace 目录的 `allowedRoots`。
现有 ACP 处理器在修改会话前验证绝对目标路径存在、是目录，且实际解析后位于该根目录内。
忽略客户端提交的 containment roots。允许普通子目录及返回工作区根目录，拒绝 symlink
逃逸、其他工作区或相邻目录。保留现有 folder-trust 与 sandbox 校验。

兼容主工作区 cd 的现有行为，包括既有目录选择策略。不开放内部 Conversations 工作区或
SSH 工作区的 cd，不顺带扩大 branch/fork 支持范围。Managed 执行模式继续由现有 agent
处理器拒绝目录切换。

内部 Conversations 的 cd 拒绝路径保留结构化路由告警，包含路由、会话和归属上下文，
但 HTTP 响应不暴露内部工作区身份。SSH cd 在调用 bridge 前返回 HTTP 501 和
`code: ssh_workspace_operation_unsupported`。

## 生命周期与兼容性

bridge 现有的 prompt queue 负责 cd 与会话 prompt 的排序。ACP 只修改会话 Config，
不修改进程 cwd；会话归属与历史存储仍关联原工作区。

调用方使用 `sessionScope: 'thread'` 创建独立会话，等待 cd 成功，再提交 prompt。
重启后，先在原工作区下 load 指定会话，等待 cd 成功，再提交 prompt，不需要加载其他会话。
文件备份及目录恢复由调用方负责。

这不是原子的 load-and-relocate API。采用 load 后 cd 的嵌入方，不得在 relocation 前
启用自动执行，包括可选的 `restoreAskUserQuestion` 行为。本操作不引入会话间文件系统
沙箱隔离，也不改变既有 skills 发现规则。

## 验证与回退

路由测试覆盖次级工作区分派、服务端控制的目录边界、客户端身份、独立会话、load 后 cd、
非法路径、generation 关闭以及各类归属失败状态。ACP 测试使用真实普通目录及 symlink
验证 containment，不依赖 Git。现有 primary cd 与内部工作区拒绝测试继续适用。
执行 CLI 定向测试、build、typecheck，以及
`integration-tests/cli/qwen-serve-session-cd.test.ts` 中的无界面 daemon 回归测试。
仅 `POST /session/:id/cd` 的目录越界返回 HTTP 400 和
`code: containment_violation`，而不是内部错误。其他路由及未提供路由上下文的调用，
对同一错误类型保留既有 HTTP 500 响应和 daemon 错误日志；不改变 worktree
创建/恢复或 managed relocation 的错误信号。回归测试同时固定 cd 映射与非 cd 的状态码及日志。

回退仅需撤销本次路由改动，不涉及持久化 schema、工作区注册或文件迁移。
合并前仍需上游维护者评审新的 live-session-owner 契约及次级工作区目录限制策略。
