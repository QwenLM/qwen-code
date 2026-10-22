# Managed Workspace Session 的持久化 Todo

中文 | [English](2026-10-22-managed-workspace-fetch-and-todos.md)

## 问题与范围

[#15076](https://github.com/QwenLM/qwen-code/issues/15076) 需要跨 Turn、替换 Worker 后保留任务清单。按 runtime ID 保存的 Worker 本地文件不能提供这一契约。因此由 Hosted Harness 通过已有 Session Store 的 `todo_state` 域管理 Todo。本方案扩展 #15089，不改变共享本地 CLI 的 web-fetch 行为。

依据 [issue 中已记录的决定](https://github.com/QwenLM/qwen-code/issues/15076#issuecomment-6321618001)，暂不加入原生 `web_fetch`。已准入 Shell 可在原有审批和部署策略下使用 `run_shell_command`；仅文件 profile 不获得网络权限。本改动不增加网络沙箱或出站策略。

## 准入与归属

- 仅 `hosted-workspace-files/3` 和 `hosted-workspace-shell/3` 声明 `todo_write`。旧版本、team-lead 和只读 child profile 保持原工具集合。保存的 profile 是启用来源；Worker 不注册 `TodoWriteTool`，不依赖本地 Config 开关。
- 运维显式允许 profile 后，存储的 Agent definition 可选 `/3`。公共审批选择和既有 Plan 准入判断识别这些 profile。内置默认仍为 `/1`，不会暗中放宽部署配置。
- 既有审批模式预批准 Todo；公共 Plan 模式仍拒绝这一写工具。审批识别不代表 `/3` 已获得 lifecycle、常驻 Workspace 或 SSH 资格。
- Harness 使用 core Todo 校验完整替换列表，限制序列化状态不超过 16 KiB，并拒绝仍有未完成依赖的进行中/完成任务。无效调用在申请 Runtime 前返回模型可修正的工具错误。
- 声明、输入预览和 Worker 执行均不包含原生 fetch。共享 core web-fetch 行为不变。

## 持久状态与恢复

按 tenant/workspace/session 隔离的 authority 使用已有 writer lease、版本链和资源存储提交完整列表。prompt ID 与 tool call ID 的摘要确定命令身份；输入摘要检测冲突重试。重放较早调用返回该次已提交列表，不会把更新的列表覆盖回去。

先提交状态，再提交包含结构化 `todos` 的成功工具结果。两次提交有顺序，但并非原子操作：中间失败会留下持久状态，同一命令重试可取回原始结果。这不扩大中断工具批次的恢复准入，尤其不承诺新的进行中 Shell 恢复能力。

每次新模型请求都把最新持久列表放进系统上下文，包括重新打开 Session 或压缩对话之后。恢复时冻结的请求保留原始指令，直到下一次新请求。Workspace 恢复验证 Todo 资源内容及前驱链。状态损坏会失败，不会变成空列表。该域已存在，无需修改 SQL schema。

## WebShell 行为

Managed Session 页面复用已有 Todo 列表，显示已加载历史中最后一次成功 `todo_write` 的快照。失败或 pending 调用不覆盖清单，成功写入空列表会清空展示。刷新/重连从历史重新投影；加载期间显示加载状态，仍有旧分页时明确标注快照来自已加载记录。这不是单独的服务端当前 Todo 查询接口，不能将部分历史说成完整恢复。

团队 `task_*` 的归属不变。本改动注入当前状态，不强制自动继续，也不保证模型完成所有任务。

## 验收与剩余资格验证

1. `/3` 声明 Todo、不声明 fetch；旧 profile 工具不变。显式准入 `/3` definition 的 Java 与 Harness 审批判断一致。
2. 有效 Todo 写入不申请或执行 Worker；无效列表和被依赖阻塞的状态转换返回可修正错误。
3. 重新打开同一持久 Session 保留最新列表；相同重试不改变它，同一命令身份携带不同输入会冲突。
4. 新模型请求收到当前状态；成功 UI 快照可刷新恢复，不被失败/pending 调用替换，分页限制保持可见。
5. fetch 在派发前被拒绝；Worker 不提供原生 fetch 或 Todo。

源码回归用例覆盖可覆盖的契约；按用户要求，未执行本地测试、构建或 UI/运行时验证。Java 到 Harness 部署、远程存储重放、故障恢复和视觉资格验证仍需评审验收。验收前保持 #15076 打开；本方案不代表新增 lifecycle、CSI、SSH 或 OS 隔离已经获得支持资格。
