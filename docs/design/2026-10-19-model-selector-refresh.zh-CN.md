# 模型选择器刷新

[English](2026-10-19-model-selector-refresh.md) | [简体中文](2026-10-19-model-selector-refresh.zh-CN.md)

## 问题与范围

宿主更新平台模型目录后，已打开的 Web Shell 仍可能显示旧的可选模型。为聊天模型选择器、模型弹窗及分屏增加显式刷新入口。不增加轮询、跨页面通知、平台专用请求或自动切换模型。

## 设计

Web Shell 暴露可选 `onRefreshModels({ workspaceCwd, sessionId })`。等待其 `void | Promise<void>` 结果后重载；不传回调时直接执行相同的本地重载流程。回调拒绝时停止并保留旧列表。平台目录的拉取与持久化由宿主负责。

增加 `POST /workspaces/:workspace/models/reload` 及对应 workspace SDK 方法，复用 `reloadModelProviders`。这是 selected-runtime 范围的写操作，要求认证、信任、有效运行时代际及该运行时的 client 身份。未知或不可用工作区不得回退到 primary。通过 `workspace_model_reload` 能力标记让旧 daemon 不显示不支持的入口。接口返回已有 `applied | deferred | failed` 结果，不写配置、不广播事件。

会话 action 在等待宿主之前捕获当前工作区与会话。重载该运行时后，读取现有 live-session context 并映射权威模型列表。尚未创建会话时改读 workspace providers；仅此状态允许 deferred。不得为刷新创建或回放会话。刷新 provider 缓存与模型列表元数据，包括保留模型的上下文上限，同时保留当前选择及其他会话状态。欢迎页目录异常或为空时拒绝回读并保留旧列表。按语义比较工作区与会话归属，并防止较早的同会话加载覆盖已完成的刷新。

在选择器搜索框旁以图标按钮展示刷新，覆盖思考设置子菜单。模型弹窗将同一图标放在列表之后，以免打开时键盘焦点落到刷新而不是模型行。加载时保留旧列表，阻止重复请求，失败时显示本地化错误并允许重试。主聊天框、分屏和主模型弹窗共用同一 action。非 workspace 会话及旧 daemon 不显示按钮。

## 实现边界

改动覆盖 daemon 生命周期路由及能力、TypeScript workspace SDK、Web Shell action、宿主定制接口、模型选择器 UI 和测试。复用 model-provider 重载路径。它重新读取 user/workspace 设置，并刷新选定 runtime 的环境覆盖层和 ACP 子进程环境以获取 provider 凭据；其中其他环境键也可能变化，不产生事件或响应字段。daemon 进程环境、工作流启用状态与当前模型选择保持不变。仅刷新发起请求的页面；其他页面可独立刷新。

## 验证与验收

覆盖无回调、空返回、回调失败；回调、重载、回读的顺序；当前模型不变；失败保留旧列表；重复点击；各异步阶段切换页面；欢迎页 deferred；次级工作区隔离及信任、代际失效；旧 daemon 兼容；新模型显示后可以选择。验证忙碌会话目录重载不中断生成。执行构建、类型检查、打包、定向测试、浏览器 E2E 及连续两轮干净自审。

已尝试全局 `qwen` 基线，但安装的 0.18.5-preview.0 缺少 Web Shell 静态资源。记录此限制，使用仓库浏览器测试框架及本地打包 daemon 验证。设计状态：已实现；实际验证结果记录到 E2E 报告和 PR。

## 未决问题

无。不需要配置迁移。
