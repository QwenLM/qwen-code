# 头显模式下的 provider 重试分类透传

[English](retry-classification-headless-diagnostics.md) | [简体中文](retry-classification-headless-diagnostics.zh-CN.md)

## 问题与范围

当 provider 请求在流式过程中失败、传输/流重放循环安排重试时，头显（非交互与 SDK）消费者只能在 stderr 看到一句 `Retrying provider attempt (N buffered tool call(s) discarded).`——没有原因、次数或状态。这些路径上的 `RETRY` 流事件不携带 `retryInfo`，CLI 只能回落到这条裸消息；而丰富的分类信息（`errorKind` / `classificationReason` / `transportCode` / `statusCode`）只写进调试日志文件，且需设置 `QWEN_DEBUG_LOG_FILE` 才会开启。在 v0.26.1 发布期间，正因为这种沉默，花了三轮有界诊断才把一次 6 小时的 SDK 发布停滞归因到模型端点间歇性无响应（[#15498](https://github.com/QwenLM/qwen-code/issues/15498)）。

范围：让那些在 stderr 上本不呈现任何原因的重试决策附带一行白名单标量分类。交互式 TUI 行为、重试决策、次数、延迟与流语义不变。交互式 UI 界面不在本次范围（见 #12020）。

## 决策

不给这些事件附加 `retryInfo`：交互式消费者依据 `retryInfo` 是否存在来启动倒计时（`use-llm-stream.ts`），附加它会改变交互式行为。

在 `RETRY` 流事件（`llm-chat.ts`）与透传类型 `ServerLlmRetryEvent`（`turn.ts`）上新增可选字段 `retryDiagnostics`。在裸重试被安排且分类信息在作用域内的两处填充该字段：传输/流重放分支，以及让模型续写被切断回答的续写恢复分支。`turn.ts` 将其透传，使非交互 CLI 与 SDK 协议事件可以读取。

字段只含白名单标量：`kind` 与 `reason` 是 `retryErrorClassification.ts` 中的固定标识字符串，`transportCode` 来自受控代码集合，`statusCode` 为数字。`providerCode`、`requestId` 与 `providerMessage` 是上游任意字符串，一律不包含。提取逻辑集中在一处：`retryErrorClassification.ts` 中的 `toRetryDiagnostics`，白名单在源头强制执行。

`nonInteractiveCli.ts` 的 `emitRetryProgress` 在回落消息后追加分类：

```
Retrying provider attempt (0 buffered tool call(s) discarded) [kind=transport, reason=transport-error, transportCode=UND_ERR_SOCKET].
```

## 约束

- 不改变重试决策、计数、延迟或流事件的发出顺序。
- 用户可见输出中不出现上游任意字符串。
- 不改交互式 UI；OpenTUI/Ink 适配器忽略该新字段，基于 retryInfo 的行为不变。
- 事件字段为可选增量；结构化输出消费者不受影响。
- 明确不在本次范围：重试未执行/重试预算已耗尽的决策目前不产生任何流事件——若为此新增事件，会让在 RETRY 时重置状态的消费者误以为开始新一次尝试，应在将来有合适的非重试诊断事件后单独处理。max_tokens 截断恢复循环属于计划内续写（并非失败重试），不加标注；交互式界面不在本次范围（见 #12020）。

## 验证计划

- 单元测试：`toRetryDiagnostics` 仅保留白名单字段、省略未定义的可选字段，并剥离 `providerCode`/`providerMessage`/`requestId`。
- 单元测试：core 流重放与续写恢复分别为被模拟的 socket 切断附上精确分类（`llm-chat.test.ts`）；重试助手内原本表示完整分类的局部变量名与净化类型完成消歧（`retry.ts`）；turn 原样透传（`turn.test.ts`）。
- 单元测试：头显 CLI 在两种输出格式下打印分类后缀，且在无分类时保持既有裸消息。
- 诊断证据：字段取值与 v0.26.1 诊断分支已证明充分的分类一致（`kind=transport`、`reason=transport-error`、无状态码）。

## 验收标准

- 头显模式下传输层流中断可在未设置 `QWEN_DEBUG_LOG_FILE` 时，在 stderr 显示 `kind/ reason [/ transportCode / statusCode]`。
- `npm run build`、typecheck 及受影响的 core 与 CLI 定向测试通过。
- 合并后 #15513 可关闭。
