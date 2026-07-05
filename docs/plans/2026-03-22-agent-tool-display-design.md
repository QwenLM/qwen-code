# Agent Tool Display Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add a dedicated VSCode/web UI display for Agent tool executions so subagent progress, summaries, and failures render from structured `rawOutput` instead of falling back to the generic tool card.

**Architecture:** Preserve ACP `rawOutput` through the VSCode session/update pipeline into `ToolCallData`, then let the shared web UI router detect `task_execution` payloads and render a dedicated `AgentToolCall` component. Keep the change shared in `packages/webui` so VSCode and `ChatViewer` stay aligned.

**Tech Stack:** TypeScript, React, Vitest, shared `@qwen-code/webui` tool-call components.

### Task 1: Lock in the failing data-flow behavior

**Files:**

- Modify: `packages/vscode-ide-companion/src/services/qwenSessionUpdateHandler.test.ts`
- Create: `packages/vscode-ide-companion/src/webview/hooks/useToolCalls.test.tsx`

**Step 1: Write the failing tests**

- Add a session handler test asserting `tool_call_update` forwards `rawOutput` when ACP sends a `task_execution` payload.
- Add a hook test asserting `useToolCalls` stores and updates `rawOutput` for an agent tool call.

**Step 2: Run test to verify it fails**

Run: `npm test --workspace=packages/vscode-ide-companion -- --run qwenSessionUpdateHandler.test.ts useToolCalls.test.tsx`

Expected: failures because `rawOutput` is not preserved in the current handler/hook pipeline.

### Task 2: Lock in the failing renderer behavior

**Files:**

- Create: `packages/vscode-ide-companion/src/webview/components/messages/toolcalls/index.test.tsx`

**Step 1: Write the failing test**

- Render the routed tool call with `kind: 'other'` plus `rawOutput.type === 'task_execution'`.
- Assert the task description, active child tool, summary, and failure reason render from a dedicated agent display instead of generic text output.

**Step 2: Run test to verify it fails**

Run: `npm test --workspace=packages/vscode-ide-companion -- --run packages/vscode-ide-companion/src/webview/components/messages/toolcalls/index.test.tsx`

Expected: failure because the router only keys off `kind` and no dedicated agent component exists.

### Task 3: Preserve structured agent output end-to-end

**Files:**

- Modify: `packages/vscode-ide-companion/src/types/chatTypes.ts`
- Modify: `packages/vscode-ide-companion/src/services/qwenSessionUpdateHandler.ts`
- Modify: `packages/vscode-ide-companion/src/webview/hooks/useToolCalls.ts`
- Modify: `packages/webui/src/components/toolcalls/shared/types.ts`

**Step 1: Implement the minimal data model changes**

- Add optional `rawOutput` to the VSCode session/webview tool-call types.
- Forward `rawOutput` in `QwenSessionUpdateHandler`.
- Store/merge `rawOutput` in `useToolCalls`.
- Expose `rawOutput` in shared web UI tool-call data types.

**Step 2: Run the focused tests**

Run: `npm test --workspace=packages/vscode-ide-companion -- --run qwenSessionUpdateHandler.test.ts useToolCalls.test.tsx`

Expected: pass.

### Task 4: Add the shared agent tool-call UI

**Files:**

- Create: `packages/webui/src/components/toolcalls/AgentToolCall.tsx`
- Modify: `packages/webui/src/components/toolcalls/index.ts`
- Modify: `packages/vscode-ide-companion/src/webview/components/messages/toolcalls/index.tsx`
- Modify: `packages/webui/src/components/ChatViewer/ChatViewer.tsx`

**Step 1: Implement the minimal renderer**

- Add a guard for `rawOutput.type === 'task_execution'`.
- Render task description as the header.
- Show agent name + status, currently running child tools, completion summary, and failure/cancel reason.
- Keep the layout compatible with multiple parallel agent cards by rendering each tool call independently.

**Step 2: Run the focused renderer test**

Run: `npm test --workspace=packages/vscode-ide-companion -- --run packages/vscode-ide-companion/src/webview/components/messages/toolcalls/index.test.tsx`

Expected: pass.

### Task 5: Verify the integrated surface

**Files:**

- Modify: `packages/webui/src/index.ts`

**Step 1: Export the new shared component if needed**

- Re-export any new component/types needed by VSCode or `ChatViewer`.

**Step 2: Run package verification**

Run: `npm test --workspace=packages/vscode-ide-companion -- --run qwenSessionUpdateHandler.test.ts useToolCalls.test.tsx packages/vscode-ide-companion/src/webview/components/messages/toolcalls/index.test.tsx`
Run: `npm run check-types --workspace=packages/vscode-ide-companion`
Run: `npm run typecheck --workspace=packages/webui`

Expected: all targeted tests and typechecks pass.
