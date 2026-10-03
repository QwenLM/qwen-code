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
`hosted-workspace-shell/2` 之后加入只读的 `glob` 工具。面向模型的 profile
决定提供什么，worker 准入在现有 `managed-runtime-tools/1` 身份下放宽。
与 H1 不同，glob 的声明是静态的，并非通过 worker 发现得来；不变的摘要无法
证明 worker 支持 glob。Java 和 Broker 保持不变，公开入口仍选择 `/1`。
下文的协调升级要求同样适用于私有 `/2` Session。

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
- 遍历本身受范围约束：managed `GlobTool` 以 Session 目录作为
  `containmentRoot` 构建，glob 的遍历钩子会剪掉词法路径或父目录 realpath
  离开该目录的每个条目。任何 pattern 写法（`..`、`[.][.]`、`\.\.`、花括号
  备选、软链接目录）都无法遍历、报告或计数外部内容，因此外部路径存在与否
  得到完全相同的回答。
- pattern 在被展开之前先设上界。brace-expansion 没有输出上限，glob 还会
  再次展开同一个 pattern，因此 Harness（获取前）与 worker 都会拒绝超过
  1024 字符、花括号不配对或按结构估算超过 64 个花括号备选的 pattern；通过
  后才展开，并作为快速路径检查各备选是否为绝对路径或含 `..` 段。
- 结果在到达网络、模型或持久记录之前改写为 Workspace 相对路径。Runtime
  宿主的物理目录布局不得泄露给 Harness；对搜索工具而言路径本身就是结果。

Core 的忽略规则以 Session 目录为根。位于仓库子目录的 Session 不继承祖先
目录的 `.gitignore`，依赖文件可能占满扫描上限；Session 自己的忽略文件仍
生效。本切片不承诺仓库根目录的忽略语义。宽泛 glob 仅列出的外指软链接（如 venv
的 `bin/python`）仍然可见，因为条目按其父目录的 realpath 判定。

## 上限

glob 的结果是路径列表。当序列化后的结果将超过 64 KiB 的 Session 内联上限
时，Harness 保留能放下的最长整行前缀并附加缩小范围的提示（`Narrow the
pattern or path.`），而不是把整个结果落入「输出被省略」路径——该路径由
`read_file` 的 offset/limit 重试提示补充。如果连空列表都放不下，仍走现有
的省略路径。

## 实现边界

- CLI Harness：profile 接受与固定、声明、获取前的参数校验、有界截断。
- CLI worker：准入、范围约束、Workspace 相对输出。
- Core：`GlobTool` 新增可选的 `containmentRoot` 构造选项；普通 CLI 不设置
  它，外部 glob 仍需权限确认。
- Workspace 恢复：W1 恢复通过与创建、加载相同的共享 profile 判断接受 `/2`。
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

worker 对 `glob` 的准入不按 Session 区分。不变的 worker 身份无法区分旧
worker 与支持 glob 的 worker。新 Harness 向旧 worker 派发 glob，可能让
执行结果未知并持续占用 Workspace 租约，阻塞其他 Session。

**升级要求：** 创建任何 `/2` Session 前，必须停止准入、排空已有 Runtime
worker，将本次 worker 构建部署到所有 provisioner，并确认旧 worker 既不能
被复用，也不能被新建。之后才能升级并启用 Harness 的 `/2` 路径。无法证明
这些条件时，保持 `/2` 关闭。回滚同样必须先排空 `/2` Session，再恢复旧
worker。这是由运维执行的要求，并非协商能力或自动安全检查。公开 connector
的启用仍单独处理。要支持版本混用，需先实现 worker 身份版本化或来自 worker
的能力声明。

**对已有 Session 的行为变化：** 因 glob 而引入的 realpath 边界检查作用于
所有 Hosted profile（包括 `/1`）的 `read_file`、`write_file` 与 `edit`。
在 Workspace-capability worker 上，只有 realpath 离开挂载点或落入另一个已安装
Session 的目录时才会拒绝，因此挂载点内的链接依赖
（`node_modules/@acme/ui -> ../../packages/ui`）仍可读取。boot-v1 worker 没有
Workspace 挂载点和 Session 注册表，其边界就是 Session 目录本身：经符号链接
解析到该目录之外的路径（包括链接依赖）会被拒绝，而此前可以读取。

为只读、幂等工具提供更轻的派发路径不在范围内。
