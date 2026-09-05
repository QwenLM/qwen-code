/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * @fileoverview Narrow public surface for implementing an external subagent
 * executor — the thing a host builds to honour a `SubagentConfig.executor`
 * block. Exported as `@qwen-code/qwen-code-core/subagentRuntime`.
 *
 * Deliberately NOT part of the package root entry. The agent-runtime event
 * contract and the tool-confirmation union are internal shapes whose fields
 * track the reasoning loop closely; pulling them into the root would turn each
 * one into a permanent public commitment. Hosts that need to build an executor
 * import this subpath instead, which keeps the commitment explicit and bounded.
 *
 * The same subpath-export pattern is already used for `./transcriptRecords`,
 * `./envVarResolver`, `./goalWire`, `./memoryScopes`, and
 * `./subSessionConstants`.
 *
 * See `docs/design/claude-code-web-shell-backend.md` §9.2.
 */

// ─── The executor contract ────────────────────────────────────────────────
export type {
  ExternalAgentExecutor,
  ExternalAgentExecutorParams,
  SubagentExecutor,
  SubagentExecutorCore,
} from './agents/runtime/subagent-executor.js';

// ─── Prompt rendering ─────────────────────────────────────────────────────
// Stateless extraction of `AgentCore.buildChatSystemPrompt`, so an executor
// that never builds an AgentCore still produces a byte-identical prompt.
export { renderSubagentSystemPrompt } from './agents/runtime/agent-core.js';

// ─── Turn context ─────────────────────────────────────────────────────────
export { ContextState } from './agents/runtime/agent-headless.js';

// ─── Agent configuration shapes ───────────────────────────────────────────
export { AgentTerminateMode } from './agents/runtime/agent-types.js';
export type {
  AgentExternalInput,
  ModelConfig,
  PromptConfig,
  RunConfig,
  ToolConfig,
} from './agents/runtime/agent-types.js';

export type { SubagentExecutorSpec } from './subagents/types.js';

// ─── Tool confirmation shapes ─────────────────────────────────────────────
// Needed to synthesise an `AgentApprovalRequestEvent` from a foreign agent's
// permission request — the reverse direction of what `SubAgentTracker` does.
export { ToolConfirmationOutcome } from './tools/tools.js';
export type { ToolCallConfirmationDetails } from './tools/tools.js';

// ─── Statistics ───────────────────────────────────────────────────────────
export type {
  AgentStatsSummary,
  ToolUsageStats,
} from './agents/runtime/agent-statistics.js';

// ─── Event contract ───────────────────────────────────────────────────────
// An executor's whole job is to emit these; everything downstream (JSONL
// transcript writer, SubAgentTracker, virtual subagent sessions, the Web Shell
// panel) keys off the emitter rather than off AgentCore.
export {
  AgentEventEmitter,
  AgentEventType,
} from './agents/runtime/agent-events.js';
export type {
  AgentApprovalRequestEvent,
  AgentConfirmationDetails,
  AgentErrorEvent,
  AgentEvent,
  AgentEventMap,
  AgentExternalMessageEvent,
  AgentFinishEvent,
  AgentHooks,
  AgentRoundEvent,
  AgentRoundTextEvent,
  AgentStartEvent,
  AgentStatusChangeEvent,
  AgentStreamTextEvent,
  AgentToolCallEvent,
  AgentToolOutputUpdateEvent,
  AgentToolResponsesFinalizedEvent,
  AgentToolResultEvent,
  AgentUsageEvent,
} from './agents/runtime/agent-events.js';
