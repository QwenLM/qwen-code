# Web Shell 侧栏测试 harness（共享测试脚手架）

[English](2026-08-23-web-shell-sidebar-test-harness.md) | [简体中文](2026-08-23-web-shell-sidebar-test-harness.zh-CN.md)

## 背景

侧栏测试套件反复重复同样的会话分页解析逻辑、DOM shim、会话夹具和交互辅助函数。这些副本之间对「显式未加载的分页（`data: undefined`）应如何暴露 sessions」的解释已经出现分歧。

## 决策

在 `client/test/`（该包既有的测试支撑目录，已从声明构建与覆盖率统计中排除）下新增一个共享测试 harness，覆盖稳定的共享行为。三个侧栏套件使用同一个会话分页解析器与 DOM 安装函数；两个需要构造会话夹具的套件同时共享这些夹具辅助函数。flush 辅助函数从既有的 `reactHarness` 重新导出而非复制。各套件特有的 mock 控制器与渲染选项保持本地化，因为 workspace-removal 套件还建模了额外的目录失效、channels 与多工作区路由。

DOM 安装函数（`installSidebarDomShims`）只补齐 jsdom 缺失的指针事件 API；`IS_REACT_ACT_ENVIRONMENT` 与 `Element.prototype.scrollIntoView` 由 vitest setupFile（`client/test/setup.ts`）统一负责——setupFile 先于任何测试模块体执行，在这里重复安装是不可达的空操作。

## 验证

一起运行三个侧栏套件，随后运行 Web Shell 的 typecheck 与 build。该重构不得改动生产文件或测试期望。
