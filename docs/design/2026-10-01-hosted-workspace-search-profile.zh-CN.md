# Hosted Workspace 搜索 profile：glob

[English](2026-10-01-hosted-workspace-search-profile.md) | [简体中文](2026-10-01-hosted-workspace-search-profile.zh-CN.md)

状态：已实现。解决 #13030。

## 问题与范围

Hosted Session 只能看到其固定 profile 声明的工具：
`hosted-workspace-files/1` 提供 Read/Write/Edit，`hosted-workspace-shell/1`
再加前台 Shell。两者都无法找到模型未被告知的文件：文件 profile 完全没有
搜索能力，Shell profile 只能在命令里退回 `rg`/`find`，每次都要走一次完整
的持久化派发。

本切片在新的 profile 版本 `hosted-workspace-files/2` 与
`hosted-workspace-shell/2` 之后加入只读的 `glob` 工具，沿用 H1（#12946）
的做法：由面向模型的 profile 决定提供什么，worker 准入随之放宽，而冻结的
`managed-runtime-tools/1` worker 身份不做版本化。不需要改 Java 或 Broker：
Broker 只对 `run_shell_command` 做特判，生产环境的 profile 选择仍停留在
`/1`，是否切换由 connector 另行决定。

`grep_search` 不在范围内：hosted-runtime 边界文档规定，在具备物理进程归属
和取消结算之前排除两种 Grep 实现。`list_directory` 不在范围内：它在本地
产品中默认关闭，且 `glob` 已覆盖需求。

## Harness

Hosted Harness 在 Session 创建与加载时接受这两个新 profile 字符串，与 `/1`
一样持久化进 Session 定义；以不同 profile 加载仍然是
`409 hosted_tool_profile_conflict`，已有 Session 保留其固定的 `/1` 快照。
Shell `/2` 原样继承 Shell 的接线（捕获容量、publisher 或延迟捕获选项）。

`glob` 声明包含必填的 `pattern` 和可选的 `path`（相对于 Session 保存的
工作目录）。Harness 在获取 Runtime 之前用现有的
`normalizeWorkspaceRelativePath` 校验 `path`，绝对路径或 `..` 成为模型可
纠正的拒绝，不产生 Runtime 工作，与现在 `file_path` 的处理一致。空
`pattern` 以同样方式拒绝。

glob 是只读工具，因此 hosted 审批策略在 `default` 与 `auto-edit` 模式下将
它与 `read_file` 一并预批准。

## Worker

worker 准入 `GlobTool` 并将其构建进 managed 工具集。worker 侧维持两条不变
量，因为 Glob 自身的校验允许外部路径：

- 搜索被钉在 Session 已安装上下文的目录内。省略 `path` 时解析到该目录
  （绝不使用跨 Session 共享挂载点的 workspace 级 include 列表），其他取值
  必须解析到其内部；否则以模型可纠正的工具错误结算。
- 结果在到达网络、模型或持久记录之前改写为 Workspace 相对路径。Runtime
  宿主的物理目录布局不得泄露给 Harness；对搜索工具而言路径本身就是结果。

## 上限

glob 的结果是路径列表。当序列化后的结果将超过 64 KiB 的 Session 内联上限
时，Harness 保留能放下的最长整行前缀并附加缩小范围的提示（`Narrow the
pattern or path.`），而不是把整个结果落入「输出被省略」路径——该路径由
`read_file` 的 offset/limit 重试提示补充。如果连空列表都放不下，仍走现有
的省略路径。

## 实现边界

- CLI Harness：profile 接受与固定、声明、获取前的参数校验、有界截断。
- CLI worker：准入、范围约束、Workspace 相对输出。
- Core：原样复用 `GlobTool`，不改 core。
- Java：不变。生产 connector 仍固定 `hosted-workspace-files/1`；是否为公开
  Session 启用 `/2` 是单独的部署决定。

## 验证与验收

聚焦测试覆盖：各 profile 版本的声明、`/1` Session 从未广告的 `glob` 调用
被拒、获取前的模型可纠正参数拒绝、派发时的路径规范化、内联上限处的前缀
截断，以及创建/加载中的 profile 固定。Worker 路由测试覆盖范围约束（同机
其他 Session 的文件绝不被搜索）、相对输出与 `..` 拒绝。审批测试钉住 glob
的预批准。本地验证：`packages/cli` 中涉及的文件类型检查干净，受影响的四
个测试套件（995 个测试）全部通过。

## 风险与未决问题

worker 对 `glob` 的准入不按 Session 区分：`/1` Session 的模型永远看不到该
工具，实践中是惰性的，与 H1 的形态一致。工具集之后是否转向显式的
`managed-runtime-tools/2` 版本化或 D8 AgentDefinition 固定，由维护者决定；
本切片不妨碍任一路线。为只读、幂等工具提供更轻的派发路径明确不在范围内。
