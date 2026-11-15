# 聊天记录中的 Prompt 执行上下文

[English](prompt-execution-context.md) | [简体中文](prompt-execution-context.zh-CN.md)

## 问题与范围

Web Shell 会记录用户 prompt，但没有在每条 prompt 上附带开始执行时的模型与审批模式。已有 `session_model` 和 `session_approval_mode` 记录用于恢复最新会话状态；assistant 的 `model` 描述回复所用模型。它们都不是独立的 prompt 配置快照。

给用户聊天记录增加可选的 `executionContext` 元数据。UI、传输协议、模型输入和会话恢复行为保持不变。使用共享记录器，让 CLI prompt 也具有相同元数据。范围覆盖 Web Shell 使用的基于 Config 的 ACP daemon，包括 managed transcript sink；独立的 Hosted Harness 写入器和外部 Managed Agent 后端不在本次范围内。

## 方案

`ChatRecordingService` 在 `recordUserMessage` 或 `recordMidTurnUserMessage` 构造记录时，同步读取自身所属会话的 Config，然后才进入异步写入队列。快照包含来自 `getModel()` 的 `modelId`、来自 `getAuthType()` 的可选 `authType`，以及来自 `getApprovalMode()` 的 `approvalMode`。不调用模型的命令可能尚无认证类型。不记录凭据或供应商配置。

快照属于 prompt 记录，不属于 `message`。排队 prompt 在执行到记录入口时取快照，而不是浏览器提交时。轮次中追加的输入在被取出并合入当前轮次时取快照。后续配置变更不能改变历史快照。已有 retry 与 continue 路径复用原用户记录及快照；本功能不是逐次尝试的审计日志。斜杠命令在原有记录位置保存配置，通常早于命令执行。后续模型回退或审批模式变化不会改写快照；回复模型仍以 assistant 模型记录为证据。

## 兼容性与消费者

字段为可选：旧 JSONL 仍然有效，不会用当前设置补全未知历史值。Transcript 校验保留额外顶层元数据。API 历史重建消费 `message`，因此不会把快照发给模型。会话恢复仍然消费显式的会话状态记录。Managed 消息投影与分支复制保留完整记录。UI transcript 投影及展示型导出可以省略这些元数据；本次保证源记录持久化，不保证快照的展示或导出。

## 文件与验证

修改 `packages/core/src/services/chatRecordingService.ts` 中的聊天记录类型和两个记录入口。扩展相邻的记录器测试，并为需要 getter 的已有记录器测试 Config fixture 补齐方法。若记录器测试尚未覆盖，再增加针对 transcript 保留元数据与 API 历史隔离的兼容测试。

先运行全局 CLI 基线，再运行本地 build、typecheck、bundle、定向单测，以及使用模拟 OpenAI 供应商的隔离 daemon/API E2E。检查持久化的用户记录，而不仅是流式响应元数据。供应商为模拟，daemon 和记录后端必须真实运行。测试脚本与结果存放于 `.qwen/e2e-tests/`。

## 验收标准与风险

- 普通 prompt 和轮次中追加的输入在其记录时点包含会话生效的模型、可用时的认证类型与审批模式。
- 后续 prompt 前切换配置不会改变旧快照，包括尚未完成的异步写入。
- 无此字段的旧记录仍能加载；快照元数据不会进入模型消息或恢复权限。
- Retry 和 continue 不产生重复用户记录。

审批模式描述选定的审批策略，不代表完整 sandbox、工具允许列表或逐次权限决定。模型身份由选定模型 ID 与认证类型组成，不唯一标识供应商端点。没有待定设计问题。
