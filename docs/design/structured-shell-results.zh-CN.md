# 结构化 Shell 结果

[English](structured-shell-results.md) | [简体中文](structured-shell-results.zh-CN.md)

## 范围

用版本化结构替换 Web Shell 完成态的文本解析器。保持面向模型的 llmContent 不变，并为终端保留现有人类可读文本。旧记录原文展示。后台启动确认不属于进程完成结果，保留既有格式。不修改实时输出传输。

## 契约与链路

Core 产生 shell_result 版本 1 的 returnDisplay，包含 text、output（合并stdout/stderr）、directory、exitCode、signal、pid、error、outcome、notices、truncated、outputFiles。outcome 区分完成、失败、取消和超时。空输出就是空字符串，不使用占位符。提示不混入输出。调度器及记录/回放复用现有 resultDisplay 链路，ACP 通过 rawOutput 暴露。Web Shell 校验类型标识和字段，不解析文本。终端与纯文本消费者使用 text。

## 限额与兼容

生产端展示文本完整传给 PostToolUse；在历史与录制边界用现有压缩机制限制结果中的文本字段，保留数字与状态，标记截断。ACP 同时限制结构化结果的序列化大小，保持JSON和元数据完整。SDK安全预览保留有界结构化变体，导出采集阶段携带结果；版本1的HTML文档协议使用经过脱敏处理的text回退，不引入新的文档变体。未知版本优先展示字符串 text 回退，不解释元数据；缺少 text 时展示完整 JSON。旧字符串保留原文。模型输出、已有输出文件持久化、审批与执行归属不变。

## 验证

覆盖真实生产端成功、非零退出、空输出/字面值、超时/取消、长命令提示、截断、历史回放、ACP字节限额、终端文本、SDK预览/导出及Web Shell展示。执行相关测试、构建、类型检查及完整代码审查。仓库已有构建失败单独说明。

Shell outcome 沿用现有退出错误策略：grep/rg/diff/test 的退出码 1 表示已完成但结果为否，不属于执行失败。Web Shell 遵循结构化 outcome，数字退出码仍显示在详情里。PostToolUse 和 PostToolBatch 通过共享归一化保持字符串展示字段；UI/历史继续保留结构化数据。运行耗时显示在状态旁，默认可见。

版本 1 导出文档缺少结构化元数据时，展示完整回退文本，不套用实时分类卡片。directory 表示解析后的实际执行目录。信号终止、取消和超时不展示可能由执行层补出的退出码。容器清理失败提示追加到兼容文本与结构化 notices，命令输出保持原样。
