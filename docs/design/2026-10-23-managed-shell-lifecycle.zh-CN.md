# 公开 Shell 会话生命周期

[English](2026-10-23-managed-shell-lifecycle.md) | [简体中文](2026-10-23-managed-shell-lifecycle.zh-CN.md)

## 问题与范围

Issue #15078 要求公开 Shell 会话支持关闭、归档、取消归档和删除。控制面、Harness 资源结算与 WebShell 操作已经实现这些能力，但通用 Harness 在没有配置时不声明 Shell 生命周期支持。统一后的 `hosted-workspace-shell/1` 应默认包含现有生命周期能力。

Issue #15011 暴露了相关交接失败：生命周期准入先围栏普通写者续租，随后 Harness 才收到生命周期 claim。在第一个 effects 请求到达前，写者剩余租约可能耗尽。effects 正确地要求有效租约，因此即便原写者没有变化，已受理操作仍会失败。

本次复用生命周期 v2、持久操作与原 Runtime 证明，不增加公开路由、schema、强制关闭选项或自动取消并关闭流程。文件生命周期及 MCP 的显式启用保持现有契约。

## 准入与写者交接

首次 v2 关闭或删除安装生命周期围栏时，将当前仍有效写者的租约至少保留至准入后一个已配置的 Session Store 写者租期。使用数据库时间和现有写者租期配置。在准入事务内更新原 head，不改变写者身份、generation、journal revision 或内容。

仅有效且活跃的写者获得这段有限交接时间。准入前已经过期的写者不被复活。幂等重放、失败操作重新提交、claim 获取、续期或接管均不延长这段时间。缺失 head 或写者时不产生写者。files v1 和 protocol 0 不使用此机制。

生命周期准入后，普通续租、seal 和 commit 继续被围栏。effects 授权及带 claim 的续租仍要求未过期租约。超过交接期限的请求继续拒绝。DRAINING 保留独立的仅清理写者过期续租例外，以及精确 token、generation 和当前 claim 校验。

这是为准入至 effects 投递间隔提供的有界余量，不承诺在协调器无限期不可用时一直保留写者。它覆盖报告中超过原剩余租约的间隔，同时不允许过期 effects 或无界续期。

## 能力与用户行为

未设置 `QWEN_HOSTED_LIFECYCLE_V2_PROFILES` 时，仅声明 `hosted-workspace-shell/1`。显式配置仍是完整列表：空字符串禁用 v2，MCP 需要显式加入。不支持或重复的 profile 仍导致启动失败。Java 继续要求原 Worker 停止支持和当前 owner/read 授权。 既有公开子代理和普通 Shell MCP 准入也读取此能力：新建且合资格的会话会通过原有资格校验获得这些既有能力，已保存会话的范围不会被改写。

界面复用现有 WebShell 操作和进度轮询。存在活跃前台 Turn、取消中的 Turn 或未决审批时，关闭/删除以 `turn_active` 拒绝；用户取消原 Turn，等待实际结算后再次关闭。后台 Shell、Monitor 和子会话复用现有排空与级联流程。执行、输出或停止证明不确定时，操作保持恢复阻塞。

关闭保留历史和输出。归档要求关闭已完成；取消归档恢复为 CLOSED。删除在需要时先结算活跃会话，再提交 tombstone 与退役。请求已受理或取消已确认均不等于完成。

## 受影响组件

- Java 生命周期准入及其 H2/MySQL 回归调用方。
- Harness 能力默认值、显式覆盖测试与生命周期拒绝测试。
- 两种语言的当前公开 Shell、生命周期和运维文档。
- 现有 profile 合并，详见[合并设计](2026-10-23-managed-shell-profile.zh-CN.md)。

## 验证与验收

修改生产代码前，复现默认能力缺口及首个 claim 延迟失败。随后验证交接期内延迟续租、generation/revision 不变、普通写入拒绝、准入前过期与交接期后拒绝、幂等重放、重新提交、旧 claim、被替换写者及 files v1 兼容。

在共享 Java 本地预算内执行定向 H2 和真实 MySQL 用例。适用时复用匹配的 SDK 与 bundle 证据。针对 TypeScript 变更执行定向 CLI 检查、构建、类型检查和 bundle。原始失败保留在 `.qwen/issues/issue-15011.md`、`.qwen/issues/issue-15078.md` 和 E2E 报告中。

Linux CI 必须对匹配源码的公开 Shell 生命周期及 `HostedShellLifecycleRecoveryIT` 故障用例进行验证，覆盖资源结算、原 Worker 停止、保留输出和删除退役。历史绿色 CI 和 fast tier 跳过的作业均不能证明本次版本验收。本机 macOS 检查不能替代 Linux cgroup 与进程故障验收。

## 发布与待决问题

一并部署匹配的 Java、SDK、Harness 与 Runtime 产物。默认变化仅涉及 Shell 能力声明；不支持的 Runtime 配置仍拒绝公开关闭。仍可显式将生命周期列表设为空以禁用新准入，已有操作沿用现有恢复规则。存在未完成 v2 操作时不得降级消费者。

没有待决产品问题。宣布发布验收前，必须记录本机验证和所需 CI 的结果。
