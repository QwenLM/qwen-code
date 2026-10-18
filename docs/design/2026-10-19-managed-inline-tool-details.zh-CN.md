# Managed 内联工具详情

[English](2026-10-19-managed-inline-tool-details.md) | [简体中文](2026-10-19-managed-inline-tool-details.zh-CN.md)

状态：已实现，已通过隔离投影、H2 持久化和 Chromium transcript 重放夹具验证。
完整 Runtime 验收仍不在范围内。

## 问题与范围

Managed 工具生命周期事件只有名称和状态，已保存的模型参数、输出与错误仍在私有存储中。
没有 O3 发布时，失败的 ReadFile 展开为空白，Shell 无法显示命令及输出。
耗时还会错误地让空的 Shell 执行详情列表出现。

本次仅为 `read_file` 和 `run_shell_command` 提供有界内联详情。
不改变工具执行、路径校验、Runtime 选择、权限、原始捕获、下载或 O3 发布验证。
其他工具仍只显示元数据。绝对路径读取失败仍是失败，显示诊断不会授权该路径。

## 发布与授权

`qwen.managed-agent.harness.tool-details-enabled` 默认 `false`，可通过
`QWEN_MANAGED_AGENT_TOOL_DETAILS_ENABLED=true` 设置。启用代表部署方明确批准向
**所有获准读取该 Session 的用户** 发布工具参数和面向模型的文本，包括文件内容、
命令与错误。这是独立的内联发布策略，不是秘密脱敏器、Artifact 策略或按用户授权的调试权限。

已认证的私有 Harness 事件流本来就传输已提交消息；此次从相同消息增加有界显示投影。
Java 在将显示字段持久化到现有 `item.tool_call.updated` 事件和 Item 前，独立检查
部署策略、工具名称和字段白名单及大小上限。即使升级 Harness，默认仍只有元数据。
现有 Session/Workspace 读取授权继续保护 transcript 和 SSE。

已发布的详情成为持久化 Session 内容。关闭配置只停止后续发布，不能撤回已发布事件。
开启配置不会回填已经消费过的纯元数据事件；旧卡片因此显示不可用提示，直到另行设计
获得授权的回填。原有 O3 捕获发布和下载策略保持独立且不变。

## 投影与边界

模型调用 ID 与现有公开 Item 标识不变。intent 可携带原参数；已提交的工具结果消息
携带输出及错误，包括未生成执行回执的参数校验失败。结果仅可从同一 prompt 的最近一条
在先 assistant 批次、且调用 ID/名称匹配时复用参数。不读取活跃 Runtime、不遍历捕获、
不新增公开端点、不重放执行。

输入仅含适用于工具的标量显示字段：`command`、`directory`、`timeout`、`file_path`、
`path`、`offset`、`limit`。输入 JSON 最大 4 KiB，输出 JSON 最大 8 KiB。
文本截断遵守 Unicode 码点和 JSON 转义边界，`truncated=true` 标记有界预览。
输出仅使用已保存的文本 `output` 和 `error`，不复制私有捕获引用、传输请求头/凭据、
媒体或任意 outcome 字段。获准发布的文本自身可能包含敏感数据。
Java 独立丢弃格式错误或超限字段。
显示投影不等于 O3 ToolResult，也不表示 Artifact 可用。

## 界面行为

现有 Managed reducer 接收 `input`、`output`、`truncated` 并在 transcript 重放中保留。
ReadFile 显示已保存的错误；缺少详情时显示明确的不可用提示；显式空结果显示独立的空输出提示。
Shell 保持命令、输出和耗时状态可见，仅在有实际字段行时显示执行详情。
现有结构化 Shell 结果及获准发布的 O3 摘要继续保持原有展示和生命周期语义。

## 验证与验收

修改生产代码前复现字段缺失和空面板。覆盖默认拒绝、支持的工具、调用匹配、参数校验错误、
空输出、转义/Unicode 上限及无需执行工具的重放。用隔离夹具验证 Java 策略与事件/Item
持久化投影，用隔离界面检查浏览器渲染和刷新。运行相关测试、根目录 build/typecheck/bundle
和 Maven 验证。不得通过在用户 Session 运行命令或重置其数据库来测试。

验收要求：批准发布时可见已保存的 ReadFile 诊断和 Shell 参数/输出；关闭策略时无新增披露；
历史详情不可用时展开面板不留白。完整 Hosted/fault、Linux 隔离、远程执行和上游模型验收
不属于本次显示修复，不能根据投影测试推断其通过。
