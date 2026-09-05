/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * @fileoverview SubagentExecutor — the executor contract returned by
 * `SubagentManager.createAgentHeadless`.
 *
 * `AgentHeadless` is the in-process implementation. An executor that drives an
 * external agent over ACP implements the same contract, so the Agent tool,
 * background resume, and the workflow orchestrator stay agnostic of where the
 * turn actually ran.
 *
 * The member set mirrors the production call surface exactly — nothing here is
 * speculative. See `docs/design/claude-code-web-shell-backend.md` §9.1 for the
 * per-member enumeration with call sites.
 */

import type { Config } from '../../config/config.js';
import type { SubagentExecutorSpec } from '../../subagents/types.js';
import type { RuntimeContentGeneratorView } from './agent-context.js';
import type { AgentEventEmitter, AgentHooks } from './agent-events.js';
import type { ContextState } from './agent-headless.js';
import type { AgentStatsSummary } from './agent-statistics.js';
import type {
  AgentExternalInput,
  AgentTerminateMode,
  ModelConfig,
  PromptConfig,
  RunConfig,
  ToolConfig,
} from './agent-types.js';

/**
 * Narrowed view of an executor's core.
 *
 * Callers reach through `getCore()` for exactly three facts, so an external
 * executor does not have to fabricate a whole `AgentCore` to satisfy them.
 * `AgentCore` satisfies this structurally.
 */
export interface SubagentExecutorCore {
  getEventEmitter(): AgentEventEmitter;
  readonly modelConfig: ModelConfig;
  readonly runtimeView?: RuntimeContentGeneratorView;
}

export interface SubagentExecutor {
  /**
   * Runs one task. Implementations must reject or serialize a concurrent call
   * rather than interleave two turns.
   */
  execute(
    context: ContextState,
    externalSignal?: AbortSignal,
    options?: { resetStats?: boolean },
  ): Promise<void>;

  /**
   * Re-runs with external inputs (e.g. messages drained from `send_message`)
   * injected into the turn.
   */
  executeExternalInputs(
    inputs: AgentExternalInput[],
    externalSignal?: AbortSignal,
    options?: { resetStats?: boolean },
  ): Promise<void>;

  getFinalText(): string;

  getTerminateMode(): AgentTerminateMode;

  getExecutionSummary(): AgentStatsSummary;

  getCore(): SubagentExecutorCore;

  /**
   * Registers the drain callback the reasoning loop calls between tool rounds
   * to pick up external messages (e.g. from `send_message`).
   *
   * Required: two call sites invoke it unconditionally. An executor with no
   * mid-turn input channel should accept and retain the provider without
   * acting on it.
   */
  setExternalMessageProvider(provider: () => AgentExternalInput[]): void;

  /**
   * Mid-turn external message waiting. Both are optional: every call site
   * invokes them through `?.`, so an executor without a steering channel can
   * omit them and the caller loses the capability instead of failing.
   */
  setExternalMessageWaiter?(
    waiter: (signal: AbortSignal) => Promise<AgentExternalInput[]>,
  ): void;
  setExternalMessageWaitPredicate?(predicate: () => boolean): void;

  /**
   * Releases resources the executor owns beyond the turn itself — for an
   * external executor, the agent child process. Optional because the
   * in-process executor owns nothing to release.
   *
   * `createAgentHeadless` composes this into the `dispose` it returns, so a
   * caller's existing `finally { await dispose() }` also reaps the child.
   * Without that composition an external agent process outlives its subagent.
   */
  dispose?(): void | Promise<void>;
}

/**
 * Everything a host-supplied executor needs to build a `SubagentExecutor` for
 * one invocation. Mirrors the inputs `SubagentManager.createAgentHeadless`
 * already assembles for `AgentHeadless.create`, plus the declared `spec`.
 *
 * `promptConfig.systemPrompt` arrives as an unrendered template. Rendering it
 * is the host's job; see §9.1.3 of the design doc for why the render is
 * stateless and extractable.
 */
export interface ExternalAgentExecutorParams {
  /** The `executor` block declared by the agent definition. */
  spec: SubagentExecutorSpec;
  /** Agent definition name. */
  name: string;
  /**
   * The definition's approval mode, already resolved by the loader (which
   * bridges Claude-style `permissionMode` into `approvalMode`).
   *
   * An external executor MUST derive the foreign agent's permission mode from
   * this rather than letting the external agent inherit its own local config:
   * a host-side "ask" intent silently becomes auto-approve otherwise. See
   * §9.4 of the design doc — this was measured, not theorised.
   */
  approvalMode?: string;
  /** The definition's raw Claude-style permission mode, when it declared one. */
  permissionMode?: string;
  promptConfig: PromptConfig;
  modelConfig: ModelConfig;
  runConfig: RunConfig;
  toolConfig?: ToolConfig;
  eventEmitter?: AgentEventEmitter;
  hooks?: AgentHooks;
  taskName?: string;
  subagentId?: string;
  /**
   * The subagent's own derived runtime view, not the parent's. Same value
   * `AgentHeadless.create` receives as `runtimeContext`.
   */
  runtimeContext: Config;
}

/**
 * Host-supplied factory for subagents whose turn runs in an external agent
 * process rather than the in-process reasoning loop.
 *
 * Injected via `Config.setExternalAgentExecutor`. `packages/core` deliberately
 * has no ACP dependency, so the implementation lives in the host package
 * (`packages/cli`) — the same inversion `setSessionWorkflowEnabledProvider`
 * and `setMcpBudgetEventCallback` already use.
 */
export interface ExternalAgentExecutor {
  create(params: ExternalAgentExecutorParams): Promise<SubagentExecutor>;
}
