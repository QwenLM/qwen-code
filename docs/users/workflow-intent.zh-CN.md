# 为当前回合建议使用 Workflow

[English](workflow-intent.md) | [简体中文](workflow-intent.zh-CN.md)

启用 `tools.workflowsEnabled` 后，在人类提交的请求中加入 `ultracode` 或已有的
`workflow` 关键词，可以建议模型在当前回合使用 Workflow 工具。例如：
`ultracode: 检查这三个模块`。模型自行判断工作流是否适用。关键词不会直接启动工作流、
更改权限、选择模型或调整 effort。

Ink 和 OpenTUI 的终端输入、IDE 编辑器输入框、Web Shell 输入框支持这项提醒。
提醒作为独立内容加入模型请求，显示的用户消息保持原文。下一次普通提交不会继承它。
工具续段和自动重试不会再次添加提醒。
输入框中粘贴的正文计入人类原文；附件展开和 Hook 增补的上下文不计入。

历史召回和 Ink Vim 寄存器粘贴仍按 unknown 输入处理，清空缓冲区或关闭 Vim 后也不会
恢复为新鲜人类输入。Vim 插入模式下的新输入仍可触发提醒。

`ultracode` 排除完整引用、代码引用和路径形式的 token，例如 `ultracode.js`、
`x-ultracode`、`ultracode/file`。已有 `workflow` 兼容规则接受按空白分隔、
边缘带标点的独立词，例如 `(workflow)`，但不接受 `workflows` 或
`my-workflow-runner`。两个关键词同时出现时只添加一次提醒。

普通 `qwen -p`、普通 stdin、定时输入和 SDK 字符串 prompt 不会自动触发。
TypeScript SDK 的流式输入可以对每条原始人类消息分别声明来源：

```ts
import { query, type SDKUserMessage } from '@qwen-code/sdk';

async function* messages(): AsyncIterable<SDKUserMessage> {
  yield {
    type: 'user',
    session_id: crypto.randomUUID(),
    parent_tool_use_id: null,
    origin: { kind: 'human' },
    message: { role: 'user', content: 'ultracode: 检查这些模块' },
  };
}

for await (const event of query({ prompt: messages() })) {
  console.log(event);
}
```

应用生成的上下文、自动化消息、工具结果和历史回放应省略 `origin`。
缺失或无效的来源声明不会影响普通聊天，只是不添加关键词提醒。来源声明不授予工具权限。
ACP 客户端可以复用逐请求 `_meta['qwen.submittedPrompt']` 声明原始人类文本；
daemon 私有元数据仍由 daemon 保留。

设置 `ui.disableWorkflowKeywordTrigger: true` 可以在这些入口关闭两个关键词。
终端设置对话框中的 **Disable Workflow Keyword Trigger** 对后续新提交即时生效。
工作流功能或必需工具不可用时也不会添加提醒。仅允许运行命名工作流的会话只会建议以
`{ name, args }` 调用已保存工作流，不会建议编写脚本。
