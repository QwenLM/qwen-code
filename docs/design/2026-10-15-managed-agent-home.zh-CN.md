# 在 Web Shell 首页使用 Managed Agent

[English](2026-10-15-managed-agent-home.md) | [简体中文](2026-10-15-managed-agent-home.zh-CN.md)

## 问题与现状

Managed 对话已经复用 WelcomeHeader、ChatEditor、MessageList 和 ToolApproval，见[标准 Web Shell 界面设计](2026-10-12-managed-web-shell-usability.zh-CN.md)。但 App 仍把它放在独立管理面板中，并再显示一列会话列表。普通首页和“新任务”仍创建 daemon 会话，用户无法沿用首页流程开展托管任务。

## 行为与范围

在现有 Shell 中保留“本地”和“托管”两种模式。已配置 Java provider 的开发入口默认托管；显式本地选择和本地会话链接优先。没有 Managed provider 时保持现有首页。已有 Managed 会话深链继续可用。

模式 Tab 位于左侧会话栏的“新任务”下、历史列表上。主聊天区不显示模式工具栏；折叠和窄屏布局通过已有侧栏浮层或抽屉显示同一组 Tab。

托管首页使用标准欢迎界面和输入框。发送时一次创建绑定工作区的 Session 与首个 Turn。现有 Shell 侧栏显示 Managed 历史，替代 daemon 项目列表；“新任务”打开托管草稿。选择本地后恢复普通流程。切换模式不会取消任务、发送草稿或跨后端复制草稿。

## 组件改动与归属

App 管理所选后端、首页导航和选中的 Managed 会话。ManagedSessionsPage 保留现有列表、转录、事件流、准入、草稿、审批、取消、cwd、结果与子任务状态。侧栏插槽通过 React portal 接收其现有会话导航，保持单一状态归属和一份 Managed 列表。导出的 Managed-only 入口保留当前独立布局。

WebShellSidebar 保留品牌、新任务、折叠、移动端抽屉及主题交互。传入会话内容插槽时替代 daemon catalog 区域，同时禁用隐藏 daemon 列表的请求和新任务后的 catalog 失效操作。Java ID 不进入 daemon 会话方法；未传插槽时，本地列表行为不变。

使用已有 UI primitives 和 Shell 布局变量。对话保留共享消息、工具和审批组件。Managed 上下文控件沿用共享输入框和上下文呈现方式，去掉独立管理页外框。

## 能力与持久化

工作区选项只来自 Java 授权发现接口。模型选择仍是已发布的 AgentDefinition 预设。审批策略、任意模型选择、附件、文件引用、斜杠命令和客户端 Shell 模式仅在 Managed 合约支持时显示；本次不增加这些后端能力。

保留 provider 身份和存储 scope，以及冻结的幂等请求。模式切换保留草稿和待确认请求。URL 独立于设置面板记录当前模式和 Managed 会话，显式本地选择刷新后保留。打开本地会话时切换到本地。provider 身份变化仍按原有规则丢弃旧的进行中界面归属。

Managed 状态归属在隐藏时继续挂载，但禁用其输入框及全局键盘捕获。任务、结果和目录对话框只在会话可见时呈现。前台托管输入框通过与停止按钮相同的服务端权限处理 Escape 取消；输入法、审批和对话框优先。

## 涉及文件

- App 和 Managed URL 状态：首页选择、本地/托管切换、已有深链与新任务路由。
- WebShellSidebar：会话内容插槽和 catalog 归属门禁。
- ManagedSessionsPage：把现有历史移入插槽，采用首页布局，去掉重复工具栏和列表。
- 共享样式、本地化文案、聚焦测试与 Web Shell 使用文档。

## 约束与风险

不改变 Java API、schema、Runtime 供给和工具范围。复用现有组件，不把 Java 数据强塞进依赖 daemon 的 ChatPane。侧栏折叠、移动端重挂载不能重置 Managed 对话或请求归属。任务在界面隐藏时继续运行。浏览器历史和本地会话导航不能让用户停留在错误后端。

## 验证与验收

记录未修改界面的浏览器基线和全局 CLI 版本。全局 CLI 无法运行该开发环境专用的 Java provider 入口，因此浏览器基线和验证使用实际 Vite 入口以及真实本地 Java 栈，并明确记录这个边界。

运行模式和深链持久化、侧栏归属、Managed 导航、草稿、准入、审批和取消相关聚焦测试；完成仓库 build、typecheck 和 bundle。进行两轮干净自审及独立评审。

浏览器验收覆盖直接进入首页、只有一份会话列表、显式选择授权工作区、创建并发送、真实文件效果、后续轮次、Shell 单次审批、取消、刷新和历史、本地切换时 Java ID 不进入 daemon 端点、切回托管以及窄屏。使用新的测试会话和文件，保留用户已有对话，服务继续运行。受控测试可覆盖故障，但不能替代真实模型和工具闭环。

## 未决问题

本次切片无未决问题。用户已选择保留两种模式，Managed 演示入口默认托管。完整工具对齐和其他 Managed API 另行开发。
