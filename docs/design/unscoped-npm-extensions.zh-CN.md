# 无 scope 的 npm 扩展来源

[English](unscoped-npm-extensions.md) | [简体中文](unscoped-npm-extensions.zh-CN.md)

## 问题与范围

扩展安装及更新解析目前要求 `@scope/name`。通过同一 npm 分发流程支持
`name`、`name@version` 和 `name@tag`，覆盖 CLI 与 daemon 安装。
不增加 npm 别名，不改变版本选择策略或运行时归属。

## 设计

- 扩展 npm 解析并增加通用来源判断函数，保留已导出的仅 scoped 包判断函数的兼容行为。
- 保留现有本地文件/目录优先级、URL 处理及 `owner/repo` GitHub 简写。
  显式路径不得变成 npm 来源。不存在的裸文件名若也是有效包名，则视为 npm 来源；
  若意图使用本地文件，应使用显式路径。
- 无 scope 包使用显式 registry 覆盖、`.npmrc` 默认 registry 或 npmjs，
  不选择 scoped registry。照常保存 registry 和来源，使更新使用同一包及 registry。
- daemon 预检查支持裸 npm 来源，保留现有 scoped marketplace 选择器及 URL 校验。
  daemon 路由中的无 scope marketplace 选择器不在本次范围内。
  路由归属不变：全局变更流程保留原有准备/提交上下文，选定工作区路由继续使用已解析的运行时。
- 更新 CLI 帮助和面向用户的 npm 文档。

## 消费方与涉及文件

核心 npm 和 marketplace 模块供 CLI 安装、TUI 扩展操作、Web Shell 发现/来源注册
及 daemon 安装路由使用。扩展管理器的安装/更新准备流程下载 npm 包；共享更新分发器
服务 CLI/TUI 更新和后台检查。`workspace-extensions.ts` 中的 daemon 预检查也需使用
通用判断函数。托管包准备流程也使用共享解析器与 npm 下载器。
同目录核心测试和 daemon server 测试覆盖改变的边界。

## 验证与验收

使用隔离的测试 npm registry 及根目录含扩展清单的无副作用包。验证 scoped 对照、
无 scope 裸包名/latest 安装和升级、精确版本固定、beta 标签升级、重复检查已最新，
以及显式缺失路径不会请求 npm。单元测试覆盖来源分类、registry 解析、下载 URL
及 daemon 预检查。执行构建、类型检查、bundle、定向测试及两轮自审。
基线和 E2E 证据记录在 `.qwen/e2e-tests/unscoped-npm-extensions.md`。

## 风险与待定问题

裸包名可能与本地文件名重叠；已存在的本地条目保持优先。现有相对路径/GitHub
简写歧义不属于此次改动范围。没有待定设计问题。
