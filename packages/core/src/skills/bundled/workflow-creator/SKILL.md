---
name: workflow-creator
description: Create or update reusable Dynamic Workflow JavaScript files under .qwen/workflows. Use when the user asks to create, save, edit, or reuse a Dynamic Workflow, including requests started from the Web Shell Workflows page.
---

# Workflow Creator

Create and maintain saved Dynamic Workflows for the current workspace.

## Boundary

- This skill manages `.qwen/workflows/<name>.js` files used by the `workflow` tool and exposed as `/<name>` slash commands.
- Do not create or edit `qwen-workflow-design/*.yaml`; those Task Flow definitions are a different feature.
- Use project scope by default. Write to `~/.qwen/workflows` only when the user explicitly asks for a workflow shared across projects.

## Workflow

1. Inspect the current task and any existing workflow with the requested name. Ask a question only when the goal, ordering, or write scope is materially ambiguous.
2. Choose a lower-case name containing only letters, digits, and hyphens. It must start with a letter and be at most 41 characters.
3. Create the smallest script that captures the requested phases, dependencies, and final result. Do not add speculative branches, retries, or agents.
4. Read the saved file back and verify its name, metadata, phase order, dependency flow, and final return value. Do not execute it unless the user also asks to run it.
5. Report the saved path and slash command. In Web Shell, tell the user to return to Workflows and refresh the Saved tab if it is already open.

## Script contract

- Start with a literal metadata declaration:

```js
export const meta = {
  name: 'Release readiness',
  description: 'Inspect, validate, and summarize a release candidate',
};
```

- Use the sandbox globals documented by the `workflow` tool: `phase(title)`, `log(message)`, `agent(prompt, options?)`, `parallel(thunks)`, `pipeline(items, ...stages)`, `workflow(nameOrRef, args?)`, `args`, and `budget`.
- Scripts cannot import modules or access the filesystem, shell, environment, or network directly. Put required reads and actions in explicit agent prompts.
- Give every agent a complete, scoped prompt and a concise `label`. State whether it may edit files.
- Express real concurrency as `parallel([() => agent(...), () => agent(...)])`. Do not pass already-started promises to `parallel`.
- Keep dependent work sequential and pass prior results explicitly.
- Put variable user input in `args` instead of hard-coding one-off values.
- End every successful path with an explicit `return` of the final result. A trailing expression is not a return value.
- Do not use `node --check` for validation: valid workflow scripts may contain top-level `await` and `return` because the runtime wraps them in an async function.

## Updates

- Preserve unrelated behavior and metadata when editing an existing workflow.
- Do not overwrite an existing workflow with a different design unless the user requested that update.
- Do not delete or rename a workflow unless the user explicitly asks.
