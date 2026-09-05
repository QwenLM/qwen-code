---
description: "Qwen Code Fork Subagent design. Run parallel tasks with shared context and prompt cache for cost-efficient AI coding workflows."
---

# Fork Subagent Design

> Implicit fork subagent that inherits the parent's full conversation context and shares prompt cache for cost-efficient parallel task execution.

## Overview

When the Agent tool is called without `subagent_type`, it triggers an implicit **fork** — a background subagent that inherits the parent's conversation history, system prompt, and tool definitions. The fork uses `CacheSafeParams` to ensure its API requests share the same prefix as the parent's, enabling DashScope prompt cache hits.

## Architecture

```
Parent conversation: [SystemPrompt | Tools | Msg1 | Msg2 | ... | MsgN (model)]
                              ↑ identical prefix for all forks ↑

Fork A: [...MsgN | placeholder results | "Research A"]  ← shared cache
Fork B: [...MsgN | placeholder results | "Modify B"]    ← shared cache
Fork C: [...MsgN | placeholder results | "Test C"]      ← shared cache
```

## Key Components

### 1. FORK_AGENT (`forkSubagent.ts`)

Synthetic agent config, not registered in `builtInAgents`. Has a fallback `systemPrompt` but in practice uses the parent's rendered system prompt via `generationConfigOverride`.

### 2. CacheSafeParams Integration (`agent.ts` + `forkedQuery.ts`)

```
agent.ts (fork path)
  │
  ├── getCacheSafeParams()          ← parent's generationConfig snapshot
  │     ├── generationConfig        ← systemInstruction + tools + temp/topP
  │     └── history                 ← (not used — we build extraHistory instead)
  │
  ├── forkGenerationConfig          ← passed as generationConfigOverride
  └── forkToolsOverride             ← FunctionDeclaration[] extracted from tools
        │
        ▼
  AgentHeadless.execute(context, signal, {
    extraHistory,                   ← parent conversation history
    generationConfigOverride,       ← parent's exact systemInstruction + tools
    toolsOverride,                  ← parent's exact tool declarations
  })
        │
        ▼
  AgentCore.createChat(context, {
    extraHistory,
    generationConfigOverride,       ← bypasses buildChatSystemPrompt()
  })                                   AND skips getInitialChatHistory()
        │                              (extraHistory already has env context)
        ▼
  new GeminiChat(config, generationConfig, startHistory)
                          ↑ byte-identical to parent's config
```

### 3. History Construction (`agent.ts` + `forkSubagent.ts`)

The fork's `extraHistory` must end with a model message to maintain Gemini API's user/model alternation when `agent-headless` sends the `task_prompt`.

Three cases:

| Parent history ends with      | extraHistory construction                                              | task_prompt                    |
| ----------------------------- | ---------------------------------------------------------------------- | ------------------------------ |
| `model` (no function calls)   | `[...rawHistory]` (unchanged)                                          | `buildChildMessage(directive)` |
| `model` (with function calls) | `[...rawHistory, model(clone), user(responses+directive), model(ack)]` | `'Begin.'`                     |
| `user` (unusual)              | `rawHistory.slice(0, -1)` (drop trailing user)                         | `buildChildMessage(directive)` |

### 4. Recursive Fork Prevention (`forkSubagent.ts`)

`isInForkChild()` scans conversation history for the `<fork-boilerplate>` tag. If found, the fork attempt is rejected with an error message.

### 5. Background Execution (`agent.ts`)

Fork uses `void executeSubagent()` (fire-and-forget) and returns `FORK_PLACEHOLDER_RESULT` immediately to the parent. Errors in the background task are caught, logged, and reflected in the display state.

## Data Flow

```
1. Model calls Agent tool (no subagent_type)
2. agent.ts: import forkSubagent.js
3. agent.ts: getCacheSafeParams() → forkGenerationConfig + forkToolsOverride
4. agent.ts: build extraHistory from parent's getHistory(true)
5. agent.ts: build forkTaskPrompt (directive or 'Begin.')
6. agent.ts: createAgentHeadless(FORK_AGENT, ...)
7. agent.ts: void executeSubagent() — background
8. agent.ts: return FORK_PLACEHOLDER_RESULT to parent immediately
9. Background:
   a. AgentHeadless.execute(context, signal, {extraHistory, generationConfigOverride, toolsOverride})
   b. AgentCore.createChat() — uses parent's generationConfig (cache-shared)
   c. runReasoningLoop() — uses parent's tool declarations
   d. Fork executes tools, produces result
   e. updateDisplay() with final status
```

## Graceful Degradation

If `getCacheSafeParams()` returns null (first turn, no history yet), the fork falls back to:

- `FORK_AGENT.systemPrompt` for system instruction
- `prepareTools()` for tool declarations

This ensures the fork always works, even without cache sharing.

## Files

| File                                                 | Role                                                                                  |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------- |
| `packages/core/src/agents/runtime/forkSubagent.ts`   | FORK_AGENT config, buildForkedMessages(), isInForkChild(), buildChildMessage()        |
| `packages/core/src/tools/agent.ts`                   | Fork path: CacheSafeParams retrieval, extraHistory construction, background execution |
| `packages/core/src/agents/runtime/agent-headless.ts` | execute() options: generationConfigOverride, toolsOverride                            |
| `packages/core/src/agents/runtime/agent-core.ts`     | CreateChatOptions.generationConfigOverride                                            |
| `packages/core/src/followup/forkedQuery.ts`          | CacheSafeParams infrastructure (existing, no changes)                                 |
