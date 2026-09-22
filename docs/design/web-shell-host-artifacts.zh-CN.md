# WebShell 宿主产物接入

[English](web-shell-host-artifacts.md) | [简体中文](web-shell-host-artifacts.zh-CN.md)

## 问题和范围

宿主目前会替代全部右侧面板打开事件。产物卡片无法在不改变会话数据的前提下过滤，外部预览渲染器无法复用内部高亮器。本变更只提供通用宿主契约，不引入产品路由、存储修改或新预览UI。

## 契约

`onRightPanelOpen` 返回false时继续原生处理；true或undefined保持既有宿主接管语义，缺省回调使用原生处理。接管判断同步执行，回调异常不触发第二次打开。既有文件审查回调优先级不变。
可选 `filterArtifact` 接收产物与来源会话/回合上下文，仅在展示turn_outputs时过滤，先于折叠计数，覆盖分屏。会话产物同步和文件变更分类保留原始数据。未传过滤函数时行为不变。
通过包公共API暴露框架无关的异步代码高亮函数，复用现有单例、语言加载和体积限制。输入代码、语言、亮暗主题，输出高亮HTML或null表示纯文本降级。不暴露可变Shiki实例；消费者负责渲染与样式，不同JavaScript运行域分别持有实例。

## 文件和边界

复用现有customization context，将展示过滤规则传到主会话、分屏和嵌套会话。ChatPane与MessageList补传来源会话身份。公共 `./code-highlighter` 入口与聊天入口在同一JavaScript运行域共享模块，独立预览无需引入聊天UI及其样式。既有codeHighlighter提供服务，不新增引擎、语法集合、主题集合或后端路由。公共README和精确就近测试描述行为。

## 验证

覆盖缺省/void/true/false回调及子Agent原生回落；主会话/分屏过滤和计数不丢数据；亮暗高亮、未知语言及超限降级。构建库和类型，运行包测试和最终上游preflight；真实浏览器验证宿主布局与独立使用不回归。状态：实现中，真实浏览器与上游门禁待执行。
