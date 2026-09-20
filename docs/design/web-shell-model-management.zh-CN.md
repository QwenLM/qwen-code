# WebShell 模型管理控制

[English](web-shell-model-management.md) | [简体中文](web-shell-model-management.zh-CN.md)

## 问题与范围

嵌入宿主可能从外部配置模型，同时保留原生模型选择。设置显隐无法阻止其他 WebShell 入口中的误增删。Issue #12335 提议实例范围的可选交互控制；这不是鉴权。daemon API、SDK、CLI、文件写入和外部下发保持不变。

## 设计

公开 `modelManagement?: WebShellModelManagementOptions`，包含独立的 `allowAdd?` 和 `allowDelete?`，默认均为 true。从公共入口导出类型。使用小型共享 helper 归一化默认值，并复用已有 slash parser 识别配置命令。

App 隐藏增删 UI，在宿主回调及隐藏命令转发之前消费被禁用的 `/auth`，过滤建议，在收紧策略时关闭已开的配置弹框，并在增删回调读取最新策略。AuthMessage 在安装前再次检查。ModelManagementSection 清理旧删除确认。SplitView 和侧任务面板向具有独立命令路由和菜单的 ChatPane 透传策略。侧任务还会在发送初始提示词前检查策略。浏览器队列在 submit/enqueue 边界读取最新策略，包括附件准备之后。不改变通用 SDK 行为。

动态限制影响之后发出的浏览器请求，不能撤销已发出的操作及 daemon 已接收的队列。恢复允许时不重新打开旧弹框。模型列表、当前标识、切换、`/model`、上下文窗口编辑和会话 `/delete` 保持原行为；设置排除策略独立组合。

## 验证

覆盖不传/空配置及四种组合、公共透传、设置与命令入口、欢迎页和分屏、宿主回调与隐藏命令优先级、动态弹框及旧回调、队列发送时最新策略。断言禁用时不发安装/删除请求，并保留选择与参数编辑回归。使用已有 DOM 测试及模拟 daemon 路由的浏览器 harness 提供 UI 证据。执行受影响测试、build/typecheck/bundle 和 preflight，如实报告基线失败及未完成项。

## 待讨论

公共 API 仍待上游评审。按贡献者明确要求，在 issue 讨论未结束时推进实现。本次不包含后端权限设计。
