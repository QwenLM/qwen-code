# 外部 Workspace 扩展执行

[English](2026-11-22-external-workspace-extension-execution.md) | [简体中文](2026-11-22-external-workspace-extension-execution.zh-CN.md)

## 状态与范围

上游评审草案。联调版本的 Linux 外部 Worker 已通过正常审批执行 Python Skill
脚本、MCP 工具和自动 command hooks。持久化 Hook 结果确认执行成功，包括获批
脚本对应的工具后 Hook。这些证据覆盖联调版本的成功路径，不代表已经重新测试
本次提取后的上游版本。完整 CI 和故障恢复验收仍待完成。公开子 Agent 能力留待后续。

## 问题与决策

外部 placement 描述 Worker 运行位置；部署明确配置扩展执行时，不应据此强制
files-only 工具档案。保留 `external-workspace` provisioner，执行档案选择
`hosted-workspace-shell/1`，固定既有 developer 扩展能力摘要。旧 files-only
和 external foreground-Shell 路径继续保留各自的准入条件。

执行配置随原始 boot 和资源 handle 传递。Session 归属、当前存储注册、审批、
扩展包 pin 和 publication binding 仍是授权依据。外部存储由所属 provider
校验，不再作为控制面本机挂载处理。共享 Worker 退役要求存储 fence 和成员 drain。

## 启用条件与兼容性

执行能力要求完整启用既有配置：使用 `external-workspace` provisioner；开启
Broker、Harness、原生 Session Store、Workspace files 与 Shell、扩展包管理与
执行以及工具 publication；执行模式为 `developer-process-group`；隔离类别为
`session`，绑定 Session 的隔离类别为 `session` 或 `workspace`。还需要扩展缓存
目录以及外部 provider 登记的存储。

未满足完整配置时，既有 external profiles 保留原有约束。仅指定 placement 不会
授予 Shell 或扩展执行权限。provider 必须在资源 handle 中保留执行配置，使启动
恢复校验与初次 boot 使用同一份配置。控制面与 Worker 制品需要配套升级。
API 及其生成客户端在降级组件枚举中加入 `agents`，使客户端可以区分不可用的子
Agent 与可用的 Skills、MCP、hooks，避免默认为包的所有能力均已可用。

## 运行行为

Worker 复用既有扩展进程归属、MCP、hook runtime 和 Session 范围的 publication
协议。异步校验重新加载资源 kind 后，segment 回执仍按流回执编码。Skill 指令
明确扩展上下文和 `$QWEN_EXTENSION_ROOT`。禁用 Python 字节码写入，避免 import
修改已固定的扩展包。子 Agent 的降级在生效组件契约中明确表达。

## 约束与验收

`developer-process-group` 在 macOS 之外新增允许 Linux。它监管已登记的进程组，
不提供 `linux-cgroup` 的进程树隔离或 drain 保证；本次变更没有完成后者验收。
未收口的 UNKNOWN execution 仍可能占据共享 Worker 的 dispatch slot；在同一
Worker 新建 Session 不构成恢复成功证据。

发布验收要求 Java 和 runtime 制品来自同一份源码，新建外部 Worker 能加载选中
的包，获批脚本及 MCP 工具返回持久结果，并有原生 hook 回执证明实际执行。
失败回传及后续回合行为单独验证。业务凭据归接入产品管理，必须能被实际 Session
HOME 读取；包激活成功不等于拥有业务访问能力。
