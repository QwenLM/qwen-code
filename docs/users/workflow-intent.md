# Request a workflow for one turn

[English](workflow-intent.md) | [简体中文](workflow-intent.zh-CN.md)

With `tools.workflowsEnabled` enabled, include `ultracode` or the existing
`workflow` keyword in a human submission to suggest using the Workflow tool
for that turn. For example: `ultracode: audit these three modules`.
The model decides whether a workflow fits the request. The keyword does not
start a workflow, change permissions, select a model, or change effort.

Terminal input in Ink and OpenTUI, IDE composer input, and Web Shell composer
input support this reminder. It is added to the model request separately from
your displayed message. The next ordinary submission does not inherit it.
Tool continuations and automatic retries do not add it again.
Text pasted into the composer counts as human input; attachment expansions
and Hook-added context do not.

Recalled history and Ink Vim register pastes remain unknown input, including
after clearing the buffer or disabling Vim. Fresh Vim insert-mode input can
still activate the reminder.

`ultracode` ignores complete quoted/code spans and path-like tokens such as
`ultracode.js`, `x-ultracode`, or `ultracode/file`. The existing `workflow`
compatibility rule accepts standalone whitespace-separated words with edge
punctuation, such as `(workflow)`, but not `workflows` or `my-workflow-runner`.
When both keywords occur, only one reminder is added.

Plain `qwen -p`, plain stdin, scheduled input, and SDK string prompts do not
automatically opt in. TypeScript SDK streaming input can explicitly identify
each original human message:

```ts
import { query, type SDKUserMessage } from '@qwen-code/sdk';

async function* messages(): AsyncIterable<SDKUserMessage> {
  yield {
    type: 'user',
    session_id: crypto.randomUUID(),
    parent_tool_use_id: null,
    origin: { kind: 'human' },
    message: { role: 'user', content: 'ultracode: inspect the modules' },
  };
}

for await (const event of query({ prompt: messages() })) {
  console.log(event);
}
```

Omit `origin` for application-generated context, automation, tool results,
and history replay. A missing or invalid origin leaves normal chat working
without the keyword reminder. The declaration grants no tool permissions.
ACP clients can use the existing per-request `_meta['qwen.submittedPrompt']`
declaration for original human text; daemon-private metadata remains reserved.

Set `ui.disableWorkflowKeywordTrigger` to `true` to disable both keywords
across these entry points. In the terminal settings dialog this is
**Disable Workflow Keyword Trigger** and takes effect for new submissions.
The reminder is also omitted when workflows or the required tool surface
are unavailable. A name-only workflow session only suggests saved workflows
with `{ name, args }`; it does not suggest writing a script.
