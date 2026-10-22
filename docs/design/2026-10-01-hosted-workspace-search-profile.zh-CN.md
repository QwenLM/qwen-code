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
初始回合与继续执行都用已保存的 profile 构建工具回合。
Shell `/2` 原样继承 Shell 的接线（捕获容量、publisher 或延迟捕获选项）。

`glob` 声明包含必填的 `pattern` 和可选的 `path`（相对于 Session 保存的
工作目录）。Harness 在获取 Runtime 之前用现有的
`normalizeWorkspaceRelativePath` 校验 `path`，绝对路径或 `..` 成为模型可
纠正的拒绝，不产生 Runtime 工作，与现在 `file_path` 的处理一致。空白或 null
`path` 按省略处理。去掉首尾空白的 `pattern` 必须为非空字符串；共享校验器在
获取前拒绝去除转义后为绝对路径或含 `..` 的花括号备选及不安全的展开，worker 再次校验
实际派发的值。pattern 用 `/` 分隔目录；反斜杠保留 glob 转义语义。

glob 是只读工具，因此 hosted 审批策略在 `default` 与 `auto-edit` 模式下将
它与 `read_file` 一并预批准。

## Worker

worker 准入 `GlobTool` 并将其构建进 managed 工具集。worker 侧维持以下不变量，
因为 Glob 自身的校验允许外部路径：

- 搜索被钉在 Session 已安装上下文的目录内。省略 `path` 时解析到该目录
  （绝不使用跨 Session 共享挂载点的 workspace 级 include 列表），其他取值
  必须解析到其内部；否则以模型可纠正的工具错误结算。
- 遍历本身受范围约束：managed `GlobTool` 以 Session 目录作为
  `containmentRoot` 构建，glob 的遍历钩子会剪掉词法路径或父目录 realpath
  离开该目录的每个条目。任何 pattern 写法（`..`、`[.][.]`、`\.\.`、花括号
  备选、软链接目录）都无法遍历、报告或计数外部内容，因此外部路径存在与否
  得到完全相同的回答。
- pattern 在被展开之前先设上界。brace-expansion 的输出上限超过 Hosted
  搜索预算，glob 还会再次展开同一个 pattern。Harness（获取前）与 worker
  都会拒绝超过 1024 字符、花括号不配对、数字端点、步长或跨度超出安全整数
  范围，或按结构估算超过 64 个花括号备选的 pattern；通过后才展开，并作为
  快速路径去除转义后检查各备选是否为绝对路径或含 `..` 段。
- 结果在到达网络、模型或持久记录之前改写为 Session 工作目录相对路径。Runtime
  宿主的物理目录布局不得泄露给 Harness；对搜索工具而言路径本身就是结果。

Hosted 搜索将遍历和匹配放在可终止的 worker thread 中，每个搜索目录的执行
上限为五秒。取消或超时会先终止该线程，再返回工具结果，因此 glob 回溯匹配
不会阻塞 Runtime 的 status 和 cancel 路由。超时返回模型可纠正的错误，提示
缩小 pattern 或 path；普通 CLI 保留原有的进程内搜索行为。

Core 的忽略规则以 Session 目录为根。位于仓库子目录的 Session 不继承祖先
目录的 `.gitignore`，依赖文件可能占满扫描上限；Session 自己的忽略文件仍
生效。本切片不承诺仓库根目录的忽略语义。宽泛 glob 仅列出的外指软链接（如 venv
的 `bin/python`）仍然可见，因为条目按其父目录的 realpath 判定。遍历该链接
会被剪掉，包括普通的 workspace 依赖链接；宽泛搜索仍保留 Session 内的匹配。

boot v2 的文件工具范围校验允许访问挂载内的共享位置，但排除同一 worker 中
另一已安装 Session 所拥有的目录。失效兄弟位置无法解析时，仍保留对原占用路径
的归属判定，但不拒绝无关共享目录的读取。可解析的重定向继续拥有其目标，包括
原先的共享目录；修复该绑定之前，目标仍拒绝访问。自身目录仍可访问；写入前，
悬空链接按其预期目标校验。这个注册表
检查只覆盖本 worker，并不保障
不同 worker 之间按 Session 保密。它保留 `/1` 的链接依赖读取；文件历史仍
保留自己的写入边界。boot v1 保持更严格的 Session 边界。请求目标的非 ENOENT 解析
错误必须拒绝，并且不得暴露 Node 诊断中的宿主物理路径。

## 上限

glob 的结果是路径列表。当序列化后的结果将超过 64 KiB 的 Session 内联上限
时，Harness 在实时回合和崩溃恢复中都保留能同时放入结果资源与转录记录的
最长整行前缀，并附加缩小范围的提示（`Narrow the pattern or path.`），
而不是把整个结果落入「输出被省略」路径——该路径由
`read_file` 的 offset/limit 重试提示补充。如果连空列表都放不下，仍走现有
的省略路径。

## 实现边界

- CLI Harness：profile 接受与固定、声明、获取前的参数校验、有界截断。
- CLI worker：准入、范围约束、Workspace 相对输出。
- Core：`GlobTool` 新增可选的 `containmentRoot` 和 `executionTimeoutMs` 构造选项；普通 CLI 不设置
  它，外部 glob 仍需权限确认。
- Workspace 恢复：W1 恢复通过与创建、加载相同的共享 profile 判断接受 `/2`。
- Java：不变。生产 connector 仍固定 `hosted-workspace-files/1`；是否为公开
  Session 启用 `/2` 是单独的部署决定。

## 验证与验收

聚焦 CLI 套件为 `hosted-glob-pattern`、`hosted-workspace-tool-turn`、
`hosted-harness-session`、`hosted-runtime-recovery`、`managed-context-worker`、
`managed-runtime-tool-executor`、`hosted-tool-approval` 与
`workspace-recovery-session`。它们覆盖各 profile 的声明与创建/加载/继续执行
时的固定、无 Runtime 开销的可纠正拒绝和规范化派发、展开预算、实时与恢复
路径在两种持久化上限内的前缀截断、相对输出和错误处理、本 worker 的文件
范围校验、链接读取、经软链接创建，以及 W1 `/2` 恢复。相对化单测固定路径
词法单元的锚定和文件系统根目录情形。Core 的 `glob` 套件覆盖受约束的遍历与
普通 CLI 行为兼容。实际验证的平台和测试总数记在 PR 验证报告中，不写进这份
会持续变化的设计清单。

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
在 Workspace-capability worker 上，没有兄弟拥有目标时，挂载点内的共享位置仍可
访问。自身目录外的访问，在 realpath 离开挂载点、落入另一已安装 Session 的目录，
或挂载根无法验证时被拒绝。兄弟位置被删除或无法解析，不再阻断无关共享依赖。
兄弟重定向到共享目录时，该目标继续被排除。归属判定是几何式的，只有一条精确豁免：
安装在调用方非根祖先目录的 Session 拥有其整棵子树，包括调用方伸出自身目录后触及
的部分；而恰好绑定在挂载根的绑定（`'.'`，即未带 `cwd_relative` 的 Workspace 选择）
不划定私有区域，从不否决其他 Session 的目标。对称地，绑定在挂载根的调用方也不持有
私有目录：其 glob 命中项与读取、写入、编辑对任何被非根兄弟拥有的目标一律拒绝，无论
路径如何拼写；没有兄弟拥有的共享位置仍可访问。嵌套或重叠安装是否允许存在属于安装时
策略，不在本切片范围内；上述归属规则适用于注册表实际接受的任何组合。挂载点内的链接依赖
（`node_modules/@acme/ui -> ../../packages/ui`）未被兄弟拥有时仍可读取。boot-v1 worker 没有
Workspace 挂载点和 Session 注册表，其边界就是 Session 目录本身：经符号链接
解析到该目录之外的路径（包括链接依赖）会被拒绝，而此前可以读取。

为只读、幂等工具提供更轻的派发路径不在范围内。
