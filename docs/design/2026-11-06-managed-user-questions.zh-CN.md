# Managed 结构化用户问答

[English](2026-11-06-managed-user-questions.md) | [简体中文](2026-11-06-managed-user-questions.zh-CN.md)

状态：已实现并完成本地验证，包括 MySQL 上等待回答期间强制终止并重启
Harness、重启 Java 服务上下文。完整 CI 和已部署服务验收仍待完成。

## 问题与当前状态

本次变更前，daemon 提供 `ask_user_question`，普通 Hosted 工具尚未提供。
公开 API 和 WebShell 契约中的问题 Action 标为 planned。Java 投影、回答 outbox、
SDK 连接器和 WebShell 只接受审批 Action。现有审批等待已经能够持久化 Action
和原生批次续接描述、隔离过期写入者，并在接管后恢复同一个等待。

本次变更需要在展示前持久化问题，在投递失败时保留回答，并让原始工具调用仅
继续一次。刷新页面必须能够重新发现问题，无需重新发送 prompt。

## 范围

支持普通 `hosted-workspace-files/1`、`/2`、`/3` 和
`hosted-workspace-shell/1` 的根 Session，包括公开 Plan 模式。问题必须是批次中
唯一的工具调用；混合批次在执行任何相邻调用之前整体拒绝。首期不向 MCP/Hook
Session、仅前台 worker、resident CSI profile 和子 Session 声明该工具，因为
这些组合的续接契约需要单独验收。保持现有审批行为兼容。

匹配原生输入字段：一至四个问题，每个包含 `question`、`header`、二至四个
包含 `label` 和 `description` 的选项，以及可选 `multiSelect`。
可选 `metadata.source` 仅作描述。所有问题必答且允许自定义文本。单选接受一个
选项或自定义文本；多选允许多个选项与自定义文本同时提交。

## 分层设计

| 层次          | 变更                                                                                                                                                                                                                                         |
| ------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Hosted 工具   | 在适用 profile 声明并校验工具。提交 `question` Action 前持久化助手批次、输入、声明和原生续接描述。在 `yolo`、`auto` 模式也等待回答。                                                                                                         |
| 持久化 Action | 保持审批 options 版本 1–3。增加问题 options 版本 4，包含现有身份、版本、时间字段、`inputRef`、`continuationRef`、`requiresHumanDecision: true`、`policyRevision: hosted-user-question/1` 和 `questions`。沿用现有不透明 Action ID 命名空间。 |
| 回答          | 保存版本 2 的 decision，包含 `answers`、`inputRevision`、`policyRevision`。每个回答包含 `questionId`、可选 `optionIds` 和可选 `text`。按原问题及选项顺序规范化，使重排的选择产生相同 decision 字节。                                         |
| Java          | 对照原始 options 校验问题投影和回答。复用 actor 作用域幂等性、鉴权、预约、`ACTION_RESPONSE` outbox 和持久化 decision receipt。不新增数据库迁移、队列或表。                                                                                   |
| SDK           | 通过现有 resolve 端点投递结构化回答。保留现有审批重载。                                                                                                                                                                                      |
| WebShell      | 投影问题 Action，使用现有基础组件渲染表单，提交稳定 ID，在投递不确定或失败时保留草稿。刷新后读取待回答 Action。                                                                                                                              |

按不可变输入顺序生成问题 ID `q1` 至 `q4`，选项 ID `q1o1` 至 `q4o4`。
标签不作为身份。公开 API 使用 snake_case；WebShell 和私有资源使用 camelCase。
复用已规划的问题 schema，并在需要时补充来源和工具身份字段。

问题文本最多 2048 字符，选项标签 256 字符，描述 1024 字符，回答文本 8192
字符。序列化工具输入最多 16 KiB，规范化回答最多 32 KiB，确保 options、decision
和续接资源不超过现有 64 KiB 上限。无效或过大的模型输入在等待前返回工具错误；
无效回答保持 Action 待回答。

## 生命周期与恢复

复用现有审批超时及 requested/decided/cancelled/expired 状态。策略变更、allow
规则、分类器或审批按钮都不能回答问题。回答必须校验 ID、选择数量、文本资格、
输入版本和策略版本。重复的等价回答返回原结果；冲突回答不能替换原回答。

复用现有原生续接描述及原 Runtime 绑定；问题本身不创建 Runtime 工具执行。
重启后校验保存的输入、声明和问题 decision，恢复同一个 Action ID，在下一次
模型请求前提交原调用的结果。decision 落盘后、结果提交前崩溃时必须复用已保存
的回答。取消和过期结束原等待，不编造回答。保留写入租约、activation 和
Workspace generation 检查。

无状态 Action journal 校验与基于 SQL 的 Action Store 分开，遵守现有类大小
门槛；这一拆分不改变事务归属、锁、资源校验或拒绝语义。

浏览器根据规范化的结构化回答及 Action/版本身份计算长度受限的幂等键，不在键
或浏览器存储中保存回答文本。采用仓库固定版本的浏览器 SHA-256 库，确保普通
局域网 HTTP 无需 Web Crypto 也能回答。同步的提交中状态阻止重复点击。投递失败或不确定
时保留原草稿用于重试；持久化回答操作确认完成后才隐藏问题。

## 受影响源码与消费者

- Hosted 声明/执行、审批辅助逻辑、原生批次续接、Harness 恢复及对应测试。
- Java Action 投影/仓储/服务/控制器、journal reader-version 提升、恢复引用校验及测试。
- Hosted Java SDK 客户端与连接器，以及审批兼容性测试。
- 公开 OpenAPI 和生成的 WebShell 类型、provider/hook、问题表单、Sessions 页面、翻译及测试。
- 能力文档和 Managed server README。

## 验证与验收

实现前使用全局 `qwen` dry-run 测试计划。使用确定性模型 fixture 请求指定问题
工具；fixture 通过不代表真实模型或已部署服务验收通过。

验收覆盖单选、多选、自定义回答、重复标签、所有审批模式、Plan、必答与大小
限制；回答前刷新；等待中及 decision 后 Java/Harness 重启；相同回答重试与
冲突回答；取消/过期；tenant/actor 隔离；现有审批 Action 不回归。聚焦 UI 和
适配器测试验证请求格式和草稿保留。真实进程与 MySQL 证据分别列出。

执行根目录 build/typecheck/bundle 和受影响 TypeScript 测试。遵守 Java 模块
包含前置准备的共享十分钟本地验证预算；本地证据不可得时，将完整 Maven、MySQL
和 Hosted/fault 检查交由 CI。完整阅读 diff，达到连续两次干净自审，再执行独立
评审。明确报告未执行的检查。

本地已通过根目录 build/typecheck/bundle、聚焦 UI/SDK/Java 测试及受影响的
审批/原生续接回归。选定的 MySQL 8.4 测试强制终止已打包 Harness，在同一测试
JVM 中重启 Java Spring 上下文并启动替代 Harness，重新读取原待回答问题并提交
回答，观察到恰好两次模型请求且没有
Runtime 工具执行。该测试使用确定性模型 fixture。decision 已持久化后的恢复
由本地 journal 接管测试覆盖；对应的真实进程故障用例、Java 进程崩溃、完整
profiles、SpotBugs、完整浏览器验收以及真实模型/已部署服务验收仍待完成。
Chromium 探针已验证普通 HTTP 和 localhost 产生相同回答键，样本包含 Unicode
和重排的选择。

## 风险与开放问题

主要风险是跨语言 decision 规范化、错误自动回答，以及 decision/结果边界的
恢复。测试必须覆盖这些边界，不能只验证 schema 接受。当前范围没有未解决的
产品决策。更广的 profile 和混合批次支持属于后续工作，不隐式声明支持。
