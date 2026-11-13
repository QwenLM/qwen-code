# 用户文件写入策略

[English](2026-10-28-user-file-write-policy.md) | [简体中文](2026-10-28-user-file-write-policy.zh-CN.md)

## 问题

将只读拒绝和硬链接保留应用到共享原子写入函数，也会影响内部存储：
worktree sidecar 需要通过 rename 恢复在 link-then-unlink 发布期间中断、停留于 nlink 2
的状态；凭证存储则使用 forceMode 替换文件并修正权限。用户文件编辑与内部持久化需要
不同的契约。

## 决策

保留主线原子写入函数的契约。在一个内部异步写入函数中实现用户文件策略，由
StandardFileSystemService.writeTextFile 和沙箱文件 worker 调用。Write、Edit、
Notebook Edit 和拦截的 sed 编辑会进入本地文件服务；沙箱 Write 和 Edit 会进入 worker。
ACP 对端不具备 writeTextFile 能力时，写入会使用配置的回退服务；默认的
StandardFileSystemService 回退服务会应用此策略。委托给 ACP 对端以及 managed
文件系统后端的写入保持各自现有契约。

对已存在的普通用户文件检查写权限。不可写时以 EACCES 拒绝，并将 Windows access
返回的 EPERM 规范化为该错误码。沿用用户文件路径跟随符号链接的行为。目标存在多个
硬链接时原地写入并启用 flush；否则委托 atomicWriteFile。保留调用方的编码，在原地
写入前立即调用 assertCanCommit，原子替换时则将其转交 atomicWriteFile。

保留硬链接会有意更新同一 inode 的每一个名字，包括工作区外的别名。这会牺牲崩溃
原子性，不能宣称写入影响只限于批准的一个路径。PR 合并前需要维护者接受这一策略。

## 范围与约束

helper 为内部实现，具有两个生产调用方，仅提供编码和现有提交否决回调，不新增公开
配置或协议字段。worktree 发布、严格读取、凭证存储、同步原子写入、daemon 路由及 CI
均保持主线生产行为。权限检查遵循当前 OS 身份的语义，包括 root 绕过权限位的能力。
本次修改不消除文件系统 TOCTOU 竞争。

## 验证与验收

- 先在当前 PR 上复现 worktree 崩溃残留和 forceMode 回归；脚本兜底前先尝试全局 CLI。
- 通过真实本地文件和沙箱 worker 请求覆盖普通及二进制写入、只读拒绝且无临时残留、
  跟随符号链接，以及另一个别名位于目标目录外的硬链接保留。
- 提交否决必须保持两个硬链接名字的内容不变；所有沙箱写入路径仍须拒绝过期版本。
- 保存带有临时硬链接残留的 sidecar 后，正式文件须恢复为 nlink 1 并通过严格读取，
  且不得修改临时名字指向的旧 inode。
- 两个原子写入函数仍须通过 forceMode 和 mode 修复只读凭证，并通过 noFollow 替换
  符号链接而不修改其目标。
- 运行定向 core 测试、格式及 lint 检查、仓库构建和 typecheck，再验证构建产物并独立审查。

## 状态

已实现。[`8339fb66` 的 macOS 验证报告](https://github.com/QwenLM/qwen-code/pull/15453#issuecomment-6459393431)
记录了 500 条定向 core 测试、针对构建后生产模块的 11 项真实文件系统检查、使用本地
mock 模型的三项构建后 CLI 工具场景，以及仓库 build、bundle、typecheck、ESLint
和格式检查，均通过。[同一 head 的 Linux CI](https://github.com/QwenLM/qwen-code/actions/runs/40623619906/job/124242666885)
通过了 39,796 条 core 测试，包括新增的用户文件及沙箱 worker 测试。原生 Windows
行为及实际沙箱后端/容器执行仍未验证。
