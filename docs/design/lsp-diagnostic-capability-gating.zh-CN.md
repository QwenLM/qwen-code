# LSP 诊断能力门控

[English](lsp-diagnostic-capability-gating.md) | [简体中文](lsp-diagnostic-capability-gating.zh-CN.md)

## 状态

已为 issue #13283 实现。

## 问题

变更前，LSP 管理器只保留成功 `initialize` 响应中的 `textDocumentSync`。因此，
诊断服务无法区分明确不支持拉取诊断的服务器与在能力已知前初始化失败的服务器。
它会预热并请求已知不支持的服务器，可能等待请求超时，并让其失败否决支持该能力的
同级服务器所返回的干净报告。

文档拉取与工作区拉取是不同能力。提供者可以支持 `textDocument/diagnostic`，同时将
`workspaceDiagnostics` 设置为 `false`。

## 目标

- 从真实初始化响应中捕获文档和工作区拉取支持。
- 声明客户端支持两种诊断拉取方法。
- 在预热或请求前排除已知不支持的服务器。
- 保留支持该能力但失败的服务器，以及初始化未知或失败服务器的失败否决。
- 当所有候选服务器均已知不支持所请求的拉取时，报告诊断不受支持。

## 范围

此变更不添加推送诊断订阅，不更改诊断归属表，也不从服务器名称或 JSON-RPC 错误
文本推断支持情况。对于能力声明不准确的服务器，现有数字 `-32601` 回退保持不变。
其他 LSP 操作不变。

## 设计

`LspServerHandle` 新增可选的每连接 `diagnosticPull` 记录，包含三态的 `document`
值和 `workspace` 布尔值。成功初始化总会设置该记录：省略或为 null 的
`diagnosticProvider` 表示文档支持未知、工作区支持为 false；明确为 false 时
两者均为 false；对象或 true 启用文档拉取；仅当对象中的
`workspaceDiagnostics: true` 时启用工作区拉取。在新连接开始前，以及连接停止或
重置时，清除此记录。

记录缺失表示未知，而非不支持。诊断选择仅排除所请求方法明确为 false 的记录。
初始就绪选择、新变为就绪的选择和不可达服务器统计使用同一谓词。因此，支持该
能力但失败的服务器仍会否决；尚未完成初始化的失败或启动中服务器仍保持不可达并
否决。

若存在已配置候选服务器，但所有相关候选服务器都已知不支持，选择阶段会直接抛出
诊断不受支持错误，不进行预热或协议请求。文档选择在判断不支持候选之前继续沿用
现有文件相关性规则。

初始化请求声明 `textDocument.diagnostic.dynamicRegistration` 为 false，并声明
`workspace.diagnostics.refreshSupport` 为 false。这些固定方法标志与客户端的静态
拉取实现一致，不增加注册或刷新行为。

## 下游消费者

- `LspServerManager` 初始化写入能力状态；启动、停止和崩溃重置清除该状态。
- `NativeLspService.getDiagnosticHandles` 选择初始文档与工作区候选，并生成全部不支持
  错误。
- `NativeLspService.newlyReadyDiagnosticHandles` 对查询期间新变为就绪的服务器应用
  相同门控。
- `NativeLspService.unreachableDiagnosticServers` 从失败否决统计中排除已知不支持的
  服务器，同时保留未知状态。
- `NativeLspService.diagnostics` 通过这些辅助方法消费文档支持。
- `NativeLspService.workspaceDiagnostics` 通过这些辅助方法消费工作区支持。

没有其他消费者读取 `diagnosticPull`。

## 约束与风险

gopls 0.22.0 和 Pyright 1.1.414 的真实初始化响应省略了 `diagnosticProvider`，
但文档拉取仍返回源码诊断。因此，省略时文档支持保持未知，并保留不支持服务器的
数字 `-32601` 回退。这有意无法避免所有文档超时：仅凭省略无法将这些服务器与
typescript-language-server 5.3.0 区分开，后者也省略该字段但返回 `-32601`。
工作区拉取仍要求明确声明支持。未知初始化继续否决错误的干净报告。

不支持动态注册，并将其声明为 false。每次连接只捕获一次能力；后续注册请求不会
更新这些能力。

## 验证

- 在基础版本复现超时和否决。
- 测试真实初始化握手以及捕获的文档/工作区标志。
- 将省略能力的初始化响应经过真实管理器后查询服务：保留文档拉取，禁用工作区拉取。
- 测试停止和崩溃重置时清除能力。
- 针对两种请求方法测试初始、新就绪和不可达路径。
- 测试全部不支持错误，以及支持服务器失败和未知状态的保守行为。
- 运行聚焦 core 测试、构建、类型检查和 preflight。

## 验收标准

- 已知不支持的服务器不接收预热或诊断拉取请求。
- 仅支持文档的提供者不接收工作区拉取请求。
- 所有已知不支持的查询报告不支持。
- 支持能力的失败和未知初始化仍否决干净输出。
- 能力状态不能存活于其连接之后。
- 现有 `-32601` 分类和所有非诊断 LSP 行为保持不变。

## 开放问题

无。推送诊断仍属于独立工作。
