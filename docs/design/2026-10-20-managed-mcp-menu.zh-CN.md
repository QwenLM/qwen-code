# Managed Session MCP 菜单

[English](2026-10-20-managed-mcp-menu.md) | [简体中文](2026-10-20-managed-mcp-menu.zh-CN.md)

## 问题与现状

Managed Session 已能固定 MCP server，Runtime 能执行其工具。公开 Session 目录
已经提供经过脱敏、持久提交的工具、资源、提示和发现状态。Managed WebShell
缺少目录适配，因此输入框中的 MCP 菜单不可用。Hosted 工具使用不透明名称，
描述也没有服务归属，仅插入服务引用无法可靠识别对应工具。

## 方案

增加只读 WebShell POST 适配接口
`/api/agent/web-shell/v1/session-mcp/query`，接收已有 Session 请求，返回已有
公开 MCP 目录。复用目录服务及 tenant、actor 和 Workspace 读权限检查。此路由
通过当前 Session 归属于持久化 Workspace 范围，不执行 Runtime 发现或工具调用。

通过 Java client 和 Managed provider 提供有类型的查询。Managed 输入框 hook
按需通过已有 MCP 菜单 actions 加载当前 Session 目录，与 Workspace 文件引用
actions 合并，不开启 daemon 功能。provider、client 或 Session 变化时取消请求，
迟到响应不能进入新作用域。重新打开菜单读取新的已提交快照，查询失败可重试。

复用输入框已有的服务引用菜单。展示每个服务的能力数量，以及工具、
资源、提示各自的发现状态，明确属于目录快照，保留 partial、failed、stale
状态。选择后插入已有的转义 `@mcp:server` 引用，表达服务使用意向，不授予权限，
也不保证服务可用。Hosted 模型工具描述补充 server ID 和原始工具名称，使模型
能够将引用与已经准入的工具对应，包括不同服务上的同名工具。

子菜单宽度受 Radix 计算的父菜单旁可用空间约束，使目录快照文字在窄视口内换行，
避免被裁切。

## 决策与范围

- 连接配方、端点和凭据继续保留在 Runtime。不增加配置编辑器、自动安装、
  profile 启用或执行接口。
- 复用现有目录 schema，不为 WebShell 复制一套定义。
- 资源和提示数量只描述目录。本次不读取或附加其内容，公开 API 尚无对应执行入口。
- failed/stale 目录条目仍允许表达服务引用意向，并明确展示发现状态，最终由
  Runtime 准入决定能否执行。
- 不改写已有 Session pin，不改变工具身份或 grant。
- 保持 Skills、文件引用和普通文本提交能力。

涉及目录 controller 与 API 契约、WebShell Managed client/provider/输入框 hook、
公共翻译以及 Hosted 工具描述。

## 验证与验收

先尝试全局 CLI 基线，再执行 Java 权限和契约定向测试、WebShell
provider/hook/输入框测试、Hosted MCP 工具广告测试。浏览器覆盖桌面和窄屏选择
及提交内容、空目录、失败目录和重新打开。Hook 测试覆盖切换 Session 或 provider
后的迟到响应。
执行仓库 build、typecheck、bundle 和 Java 模块验证。

验收要求：已有 Managed Session 的菜单可用，目录快照状态准确，服务引用能提交
且 Hosted 工具具有明确归属，不出现跨 Session 旧数据，并保持文件和 Skill 能力。
浏览器 API fixture 只验证 UI 契约，不证明实际部署的 MCP transport、上游模型行为、
SSH 支持或生产验收。

## 开放问题

本范围内没有。资源/提示执行以及各 Runtime 的部署验收另行推进。
