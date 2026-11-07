# 上下文用量中的指令统计

[English](context-usage-instructions.md) | [简体中文](context-usage-instructions.zh-CN.md)

## 问题与范围

上下文用量目前将用户、项目、扩展指令与托管自动记忆合并为记忆文件。
在接口、格式化文本、Ink、OpenTUI 和 Web Shell 中拆分类别，不改变提示词加载和 token 估算。

## 契约与兼容

在 breakdown 中新增可选的 `instructionFiles` token 数，在 usage 中新增同名路径/token 明细。
新生产端总是返回两个字段，包括空结果。`memoryFiles` 仅包含自动记忆策略和目录快照。
两个类别各自参与开销缩放和统计，每项仅计入一次。

可选字段兼容历史记录和旧 daemon。当 breakdown 缺少 `instructionFiles` 时保留旧“记忆文件”标签；
否则将 `memoryFiles` 展示为“自动记忆”。不通过路径或本地化标签猜测类别。
旧客户端仍展示 memoryFiles，但无法展示新指令类别；需升级客户端才能看到完整分类。

## 验证与验收

覆盖指令与自动记忆共存、空类别、明细开关、有无缩放的服务商总量和旧响应。
所有展示端都应正确拆分类别、保留扩展归属、保持总 token 统计。
执行生产端、传输和渲染聚焦测试、构建及类型检查，并独立验证基线和候选版本。
不改变记忆写入和检索行为。
