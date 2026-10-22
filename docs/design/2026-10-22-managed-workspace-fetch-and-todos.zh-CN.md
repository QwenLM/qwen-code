# Managed Workspace Todo 工具切片

中文 | [English](2026-10-22-managed-workspace-fetch-and-todos.md)

## 问题与范围

[#15076](https://github.com/QwenLM/qwen-code/issues/15076) 要求为 Managed Session
提供持久、用户可见的任务清单。本切片增加 TypeScript 的 `todo_write` 声明、参数准入与
Worker 执行；它尚未完成该用户流程，也不启用新的生产 profile。

根据[issue 中记录的决定](https://github.com/QwenLM/qwen-code/issues/15076#issuecomment-6321618001)，
暂缓原生 `web_fetch`。已获准使用 Shell 的会话可在现有审批与部署策略下使用
`run_shell_command`。纯文件 profile 不获得出站抓取能力。共享核心的本地 web-fetch
行为保持不变。

## Profile 与执行契约

- `hosted-workspace-files/3` 只在 `/2` 的四个文件工具上增加 `todo_write`；
  `hosted-workspace-shell/3` 只在对应 `/2` 工具集上增加 `todo_write`。
- 既有 `/1`、`/2`、team-lead 与只读子会话 profile 保留已保存的工具集。新版本避免扩大
  既有 Session 定义的权限。
- 格式错误的 Todo 参数在获取 Runtime 前被拒绝，并作为模型可纠正的工具结果返回。
  核心工具继续负责依赖关系校验。
- Worker 执行 `TodoWriteTool`。其文件通过 `Storage.getRuntimeBaseDir()` 解析到
  `todos/<runtime-session-id>.json`，取决于 Worker 的存储上下文，而不是 Workspace
  工作目录。本改动没有建立按租户独占的存储根或跨 Runtime 恢复契约。
- 成功工具结果包含更新后的清单。没有独立的 Hosted 机制恢复此文件或在模型调用间注入
  未完成任务提醒；修改 Worker Config 不会跨进程修改 Harness 模型的 Config。
- 工具获准调用时，`default`、`auto-edit` 与 `yolo` 均预批准它。公共 Plan 模式不准入
  这个写工具。Java 与 TypeScript 的 Action 预览集一致包含 Todo，不包含原生 fetch。
- 这些 profile 与 Managed Worker 均不声明或执行原生 `web_fetch`。即使模型生成了
  fetch 调用，也会在派发前拒绝。

## 用户功能交付前的剩余工作

1. 明确唯一的 Todo 启用来源，并贯穿声明、准入和两处 Worker Config。核心的
   `todoWriteEnabled` 默认是 false；无条件注册工具并不等于实现了该门禁。
2. 将 `/3` 接入适用的 Java 与 Hosted 公共 profile 判定、审批选择和能力协商。
   仅修改生产允许 profile 配置无法提供这些支持。生命周期与 Plan 支持必须明确，不能
   按版本号推断继承。
3. 确定持久 Session 状态来源与恢复行为。先评估现有工具回执和历史，再考虑引入新的
   状态存储。同一目录里的文件保留不等于替换 Worker 后可恢复。
4. 将当前清单展示到 WebShell，并在刷新、重连后恢复。团队 `task_*` 是另一套由团队
   拥有的工作流。
5. 验证选定的 Java → Harness → Broker → Worker 路径、恢复和 UI 行为后，才能声称
   原 issue 已完成。

在这些要求完成或明确调整范围前，原 issue 应保持开放。本切片只引用它，不使用自动
关闭关键词。本次范围收敛不改变 schema、部署默认值或网络策略。

## 本切片验收

1. `/3` 声明包含 Todo，不包含 fetch；旧 profile 不包含这两个工具。
2. 两种 `/3` profile 的 fetch 调用均在 Runtime 获取、预留和执行前失败；Worker 工具集
   也不包含 fetch。
3. 格式错误的 Todo 调用仍可由模型纠正且不往返 Runtime；既有同 Runtime 的 Todo 写入
   与依赖校验保持。
4. Java 和 TypeScript 的 Action 预览一致保留 Todo、移除 fetch。
5. 文档和工具描述不声称此切片具备跨 Runtime 持久化、用户可见任务面板或自动轮间提醒。
