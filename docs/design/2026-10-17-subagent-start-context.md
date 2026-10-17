# SubagentStart context delivery

[English](2026-10-17-subagent-start-context.md) | [简体中文](2026-10-17-subagent-start-context.zh-CN.md)

## Problem and scope

Issue [#14477](https://github.com/QwenLM/qwen-code/issues/14477) reports that
`SubagentStart.additionalContext` is stored in `hook_context` but never reaches
the first model request unless the agent's system prompt explicitly references
`${hook_context}`. Foreground launches, background launches and cold resumes
share this omission. Resident turns already append context to `task_prompt`,
but structured external inputs bypass that field.

This fix delivers the existing hook output; it adds no hook events, settings or
executor APIs. Container launches continue to skip parent-side agent hooks.
Workflow dispatch and internal fork helpers that do not fire `SubagentStart`
remain outside this change.

## Delivery decision

Apply the output at the hook call sites, before handing the context to the
executor. A shared helper retains `hook_context` and appends the output to the
selected execution input: `external_inputs_override` when present, otherwise
`task_prompt`.

On the first execution, an explicit `${hook_context}` system-prompt template
retains ownership of placement, without an additional copy in the task. Later
resident executions always use the new input, because their system prompt has
already been rendered. Forks use the input path and preserve the inherited
system instruction and history. Empty output and hook failures preserve the
existing task and failure behavior.

Cold native resumes retain their complete `ContextState` during the first
execution, including structured inputs and template context. Resident launches
with structured input dispatch through `executeExternalInputs`, which also
supports ACP executors. Inputs drained while finishing keep their existing
lifecycle and do not cause another start hook.

## Consumers and validation

- Foreground native agents and ACP/Codex agents receive the completed input;
  explicit custom templates still render the retained `hook_context`.
- Background native, fork and external launches use the same delivery rule.
- Resident native and ACP turns receive the current hook output with string or
  structured input. Codex does not support resident continuation.
- Cold native and fork resumes receive fresh context. Persisted external and
  container resumes remain unsupported.

Regression tests must inspect executor input, not just storage in
`hook_context`. Verify first launches, template placement without duplication,
fork prefix preservation, cold resumes, resident string/structured inputs, and
empty or failed hooks. A real CLI with a command hook and local OpenAI-compatible
server must show the marker in the first subagent HTTP request on macOS and
Docker Linux. The mock model verifies delivery, not model compliance with the
injected instructions.
