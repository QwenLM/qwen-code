/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
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

export interface SubagentExecutorCore {
  getEventEmitter(): AgentEventEmitter;
  readonly modelConfig: ModelConfig;
  readonly runtimeView?: RuntimeContentGeneratorView;
}

export interface SubagentExecutor {
  execute(
    context: ContextState,
    externalSignal?: AbortSignal,
    options?: { resetStats?: boolean },
  ): Promise<void>;

  executeExternalInputs(
    inputs: AgentExternalInput[],
    externalSignal?: AbortSignal,
    options?: { resetStats?: boolean },
  ): Promise<void>;

  getFinalText(): string;
  getTerminateMode(): AgentTerminateMode;
  getExecutionSummary(): AgentStatsSummary;
  getCore(): SubagentExecutorCore;

  setExternalMessageProvider(provider: () => AgentExternalInput[]): void;
  setExternalMessageWaiter?(
    waiter: (signal: AbortSignal) => Promise<AgentExternalInput[]>,
  ): void;
  setExternalMessageWaitPredicate?(predicate: () => boolean): void;

  /** Resolves after owned resources have been released. */
  dispose?(): void | Promise<void>;
}

export interface ExternalAgentExecutorParams {
  spec: SubagentExecutorSpec;
  name: string;
  approvalMode?: string;
  permissionMode?: string;
  promptConfig: PromptConfig;
  modelConfig: ModelConfig;
  runConfig: RunConfig;
  toolConfig?: ToolConfig;
  eventEmitter?: AgentEventEmitter;
  hooks?: AgentHooks;
  taskName?: string;
  subagentId?: string;
  runtimeContext: Config;
}

export interface ExternalAgentExecutor {
  create(params: ExternalAgentExecutorParams): Promise<SubagentExecutor>;
}
