# Managed Session 权限策略

[English](2026-10-24-managed-permission-policy.md) | [简体中文](2026-10-24-managed-permission-policy.zh-CN.md)

## 状态与问题

已完成本地实现，并与当前 main 的 Workspace files/3 profile 集成。初始验证基于
`cdd5f1e02744`，后续集成检查记录在 E2E 报告中。变更前 Managed Session
已支持 `default`、`auto-edit`、`yolo`、独立 Plan 状态及持久权限 Action。用户尚不能
设置 Session 的 allow/ask/deny 规则，也不能通过 Managed 审批设置选择已有的 Core 分类器。

## 范围与决策

扩展既有 Session 审批查询与变更操作。增加 `auto` 和可选的 `permissionRules` 对象，
包含 `allow`、`ask`、`deny` 三个字符串数组。模式、Plan 与规则共用既有
`approvalRevision`、actor 范围幂等回执、Session 授权和事务锁。不增加独立策略服务、
路由、表或数据库版本。

省略规则保留当前规则，显式传三个空数组清除规则。空策略保持既有线格式。
规则变更要求 Session 空闲；已有模式实时切换保持原行为。Turn 在现有模式和修订快照
旁保存规则快照。新规则不会自动传给另一个 Session 或委派的子会话。Auto 在 Session
创建后选择。新委派的子会话把父会话的 Auto 映射为 default，子会话协议保留原有三模式。

空闲指没有活动 Turn、待决审批或未结算操作；仅保留健康的 MCP 连接不妨碍编辑规则。
普通 Turn 保留原准入快照；内部 monitor、automation 与 Session-message 唤醒通过当前
writer 范围 SQL 读取固定策略；缺少原始真人提示时，Auto 回退人工审批。这些规则约束
模型工具调用，不约束内部唤醒投递或 Hook 副作用。

每类最多 32 条，合计最多 64 条；每条最多 512 UTF-8 字节，编码后的对象最多
8192 UTF-8 字节。规则须无首尾空白、非空、不含控制字符，且同类中不重复。
首版接受工具名与别名、MCP server/tool 名称模式、Shell 命令模式及 WebFetch
`domain:` 模式。明确拒绝文件路径限定和其他参数谓词，因为 Harness 无法解析远端
文件系统的规范路径。这些规则约束执行输入，不构成操作系统隔离边界。

## 判断与分类器

保留输入校验、授权、profile 准入和 Plan 限制。Hook 产生最终工具输入后，复用
Core 权限匹配器，按 `deny > ask > allow` 判断，再应用模式默认行为。deny 在
`yolo` 下仍有效；显式 ask、Hook ask 和退出 Plan 始终要求人工，不被 allow 规则、
Hook allow 或分类器越过。MCP 匹配使用生产者携带的 server/tool 身份，不使用
不透明的展示名或描述。复合 Shell 命令保持保守匹配。

对于其他规则未决定的原生调用，`auto` 使用 Core `classifyAction` 和 Harness
现有受保护的模型配置。模型运行器注入分类器回调，不启用本地工具或新建执行环境。
用户意图仅来自真实用户输入和可信 Session 历史。原文从已提交的真人输入资源读取，
附件文本与合成消息不会成为用户意图；Hook 扩写提示、Workspace 指令和压缩摘要不能
被提升为人类授权。分类器允许则继续，策略阻断则拒绝，分类服务不可用
则回退持久人工 Action。取消绝不放行派发。MCP 调用，以及没有安全分类器的冷恢复
续接，除非已有显式规则决定，否则保守要求人工审批。

既有原生批次计划在恢复时保留已决结果和已完成序号。在 Action options 中持久化
必须人工处理的来源，并在实时轮询和冷恢复中保留。恢复已准入操作不能重新分类
已完成调用、改写待决 Action 或重放未知工具效果。

## 组件与兼容性

| 层                  | 变更                                                                                        |
| ------------------- | ------------------------------------------------------------------------------------------- |
| Java Session store  | 在共享 V1 基线中增加 Session/Turn 规则 JSON，保持快照、回执、writer 范围读取和 CSI 清单一致 |
| Public/WebShell API | 扩展既有审批请求、选项和结果；递增 OpenAPI 并重新生成浏览器类型                             |
| SDK 与 Harness 协议 | 协商 `permission-rules/1`、`auto-approval/1`；无规则时保留原格式                            |
| Hosted 执行         | 复用 Core 匹配器与分类器、最终输入检查、原生批次恢复和持久 Action                           |
| WebShell            | 在合资格模式中增加 Auto，用共享基础组件提供 Session 规则对话框；保留待确认意图与原重试身份  |

旧版或不兼容 Harness 必须拒绝已保存的 Auto/规则策略，包括替换及池化路由后。
能力发现决定能否提供新选项，不能静默丢弃已有策略。租户、owner/OPERATOR、
Workspace 和 writer generation 校验保持权威。编辑器说明可移植语法及空闲要求。
它不编辑 daemon 设置、不修改固定 AgentDefinition，也不启用不受支持的工具。

按照仓库首发 schema 约定，直接修改共享 V1 基线。本构建需要初始化新的开发数据库，
既有数据库没有升级迁移。

## 验证与验收

E2E 计划位于 `.qwen/e2e-tests/managed-permission-policy.md`。先在隔离状态中检查全局
CLI 基线。覆盖规则优先级、复合命令、MCP 身份、非法及超限策略、分类器允许、阻断
及不可用、Plan 与 Hook ask、待决 Action 恢复、幂等、授权、旧修订、冷态策略快照及
不支持的 Harness。

执行根 build/typecheck/bundle 和受影响 Core/CLI/WebShell 测试。Java 检查共用模块
十分钟本地预算，优先审批、API/surface、schema/CSI 和 SDK 消费者，并在条件允许时
执行最小真实 MySQL/Hosted 路径。记录不可用项，完整 profile 留给 CI。完成前执行
连续两轮完整 diff 干净自审及独立评审。组件、受控模型和浏览器 fixture 证据不能
证明生产或 Linux 故障验收。不修改运行中的预览服务。

本地证据：受影响包的构建、根级类型检查与打包通过；Core、CLI 和 WebShell 定向
fixture 通过，独立源码评审未发现可操作的缺陷。Java SDK 及选定的 API、连接器和
Action 测试通过。CSI 全类曾暴露物理列顺序不匹配，现已修正，但完整绿色重跑仍待
完成；真实 MySQL 没有通过验收的证据。完整 Java/CSI、provider、Runtime 及要求的
CI 验收仍待完成，当前结果不构成生产验收。

## 待决问题与后续

本范围没有阻塞实现的产品问题。远端规范路径规则、自动 MCP 分类、部署级策略管理、
分类器计费和更广服务池验收属于后续工作。
