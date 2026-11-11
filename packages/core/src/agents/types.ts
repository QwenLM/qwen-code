/**
 * @license
 * Copyright 2025 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * @fileoverview Defines the core configuration interfaces and types for the agent architecture.
 */

/**
 * The 8 named agent colors supported by the color configuration.
 * These are mapped to theme-adapted colors at the UI layer.
 */
export const AGENT_COLORS = [
  'red',
  'blue',
  'green',
  'yellow',
  'purple',
  'orange',
  'pink',
  'cyan',
] as const;

export type AgentColor = (typeof AGENT_COLORS)[number];

import type { Content, FunctionDeclaration } from '@google/genai';
import type { AnyDeclarativeTool } from '../tools/tools.js';
import { type z } from 'zod';
import type { AgentModelConfig } from './agentModelConfig.js';
import type { AnySchema } from 'ajv';
import type { MCPServerConfig, Config } from '../config/config.js';
import type {
  EffortValue,
  ResolvedAgentReasoning,
} from '../utils/frontmatterParsers.js';
import type { ToolRegistry } from '../tools/tool-registry.js';
import type { Message } from '../protocol/transcript/message.js';
import type { ToolResultDisplayContent } from '../tools/tool-use-display.js';
import type { AgentMemoryScope } from './agentMemory.js';

/** Runtime-only key; object spread preserves it while JSON serialization does not. */
export const RESOLVED_AGENT_REASONING = Symbol('resolvedAgentReasoning');

/**
 * A single MCP server specification in an agent definition.
 * Either a string (reference to an already-configured server by name)
 * or an inline { [name]: MCPServerConfig } definition.
 */
export type AgentMcpServerSpec = string | Record<string, MCPServerConfig>;

/**
 * Describes the possible termination modes for an agent.
 */
export enum AgentTerminateMode {
  ERROR = 'ERROR',
  TIMEOUT = 'TIMEOUT',
  GOAL = 'GOAL',
  MAX_TURNS = 'MAX_TURNS',
  ABORTED = 'ABORTED',
  ERROR_NO_COMPLETE_TASK_CALL = 'ERROR_NO_COMPLETE_TASK_CALL',
}

/**
 * The default query string provided to an agent as input.
 */
export const DEFAULT_QUERY_STRING = 'Get Started!';

/**
 * Default maximum number of conversational turns for an ordinary local
 * Subagent invocation when maxTurns is omitted.
 */
export const DEFAULT_LOCAL_SUBAGENT_MAX_TURNS = 150;

/**
 * @deprecated Retained only for backward compatibility with external consumers.
 * Built-in agents no longer use these defaults — undefined means "no limit".
 */
export const DEFAULT_MAX_TURNS = 1000;

/**
 * Represents the validated input parameters passed to an agent upon invocation.
 * Used primarily for templating the system prompt. (Replaces ContextState)
 */
export type AgentInputs = Record<string, unknown>;

export interface SubagentActivityItem {
  id: string;
  type: 'thought' | 'tool_call' | 'compact';
  content: string;
  displayName?: string;
  description?: string;
  args?: string;
  toolInput?: Record<string, unknown>;
  toolResult?: {
    content: ToolResultDisplayContent;
    isError: boolean;
    toolUseResult?: unknown;
    outputFile?: string;
  };
  status: 'running' | 'completed' | 'error' | 'cancelled';
  /** For `type: 'compact'`: token count before compression. */
  preTokens?: number;
  /** For `type: 'compact'`: token count after compression. */
  postTokens?: number;
}

export interface AgentTerminationDetails {
  /** Effective turn limit when the agent terminated because it reached maxTurns. */
  maxTurns?: number;
}

/** Full notice for `AgentTerminateMode.MAX_TURNS`, used in agent results. */
export function formatMaxTurnsReachedNotice(maxTurns: number): string {
  return `Reached the maximum turn limit (${maxTurns}). The task may be incomplete. Increase maxTurns in this Subagent's configuration and retry.`;
}

/** Condensed variant for space-constrained UI rows. */
export function formatMaxTurnsReachedSummary(maxTurns: number): string {
  return `Reached max turns (${maxTurns}); increase maxTurns to continue.`;
}

export const SUBAGENT_PROGRESS_ACTIVITY_LIMIT = 5;

export interface SubagentProgress {
  isSubagentProgress: true;
  agentName: string;
  /** Stable identity used by task-scoped activity and transcript views. */
  agentId?: string;
  /** Original prompt used to invoke this agent, shown only in expanded UI. */
  prompt?: string;
  /** UI display color, forwarded from agent definition. Must be one of AGENT_COLORS. */
  color?: AgentColor;
  /** Total tool calls observed, independent of the bounded activity preview. */
  toolUseCount?: number;
  recentActivity: SubagentActivityItem[];
  state?: 'running' | 'completed' | 'error' | 'cancelled';
  result?: string;
  terminateReason?: AgentTerminateMode;
  terminationDetails?: AgentTerminationDetails;
  /**
   * Sticky flag set after ExecutionLifecycleService.background() fires for
   * this agent. Used by UI to render the "Backgrounded agent" badge
   * immediately, without waiting for STE-ordered tool_result yield.
   */
  backgrounded?: boolean;
}

export function isSubagentProgress(obj: unknown): obj is SubagentProgress {
  return (
    typeof obj === 'object' &&
    obj !== null &&
    'isSubagentProgress' in obj &&
    obj.isSubagentProgress === true
  );
}

/**
 * Indicates where an agent was loaded from.
 */
export type AgentSource = 'built-in' | 'user' | 'project' | 'plugin' | 'flag';

/**
 * Read-only view of provider-native conversation history exposed to agent
 * collaborators that need to inspect prior turns.
 */
export interface AgentConversationHistory {
  getConversationMessages(): readonly Message[];
}

export interface BaseAgentDefinition<
  TOutput extends z.ZodTypeAny = z.ZodUnknown,
> {
  /** Unique identifier for the agent. */
  name: string;
  description: string;
  /** Optional compact model-visible description used by the Lean bundle. */
  descriptionLean?: string;
  /** UI display color. Must be one of AGENT_COLORS. */
  color?: AgentColor;
  experimental?: boolean;
  /**
   * @deprecated Not consumed by the execution pipeline. Retained for
   * backward compatibility with user-defined agents that may declare it.
   */
  inputConfig?: InputConfig;
  outputConfig?: OutputConfig<TOutput>;
  metadata?: {
    filePath?: string;
    /** Where this agent was loaded from. */
    source?: AgentSource;
  };
}

export interface LocalAgentDefinition<
  TOutput extends z.ZodTypeAny = z.ZodUnknown,
> extends BaseAgentDefinition<TOutput> {
  kind: 'local';

  // Local agent required configs
  promptConfig: PromptConfig;
  modelConfig: AgentModelConfig;

  // Optional configs
  runConfig?: RunConfig;
  toolConfig?: ToolConfig;
  /** Omit project/session instruction memory for this definition. */
  omitAgentsMd?: boolean;
  /** Skip collecting a Git snapshot for this definition's requests. */
  omitGitStatus?: boolean;
  /**
   * Built-in and plugin-contributed agents only: skip registration when the
   * CLI runs as an SDK host. User/project definitions are never gated by it.
   */
  skipInSdkMode?: boolean;
  /**
   * Pin this agent to the parent session's active model, ignoring per-call,
   * definition, and env-level model overrides. Set by agents whose whole point
   * is context parity with the caller (fork).
   */
  pinToParentModel?: boolean;

  /**
   * Optional MCP servers for this agent.
   * Each entry is either a string (reference to an already-configured server by name)
   * or an inline { [name]: MCPServerConfig } definition.
   */
  mcpServers?: AgentMcpServerSpec[];

  /** Tool denylist — tools listed here are removed after registration. */
  disallowedTools?: string[];
  /** Restrict available skills to this list. */
  skills?: string[];
  /** Reasoning effort level, mapped to thinkingBudget. Supports named levels or numeric budget. */
  effort?: EffortValue;
  /** Runtime reasoning settings resolved after modelConfig/settings overrides. */
  [RESOLVED_AGENT_REASONING]?: ResolvedAgentReasoning;
  /** Initial prompt sent as the first user message (maps to promptConfig.query). */
  initialPrompt?: string;

  /**
   * Independent permission mode for this subagent.
   * When set, the subagent's tool calls are evaluated against this mode
   * instead of the parent's global permission mode.
   * Supports the five mode names, in any of their loose spellings — see
   * parsePermissionMode. 'bypassPermissions' is the old name for 'yolo'.
   * 'plan' is accepted but enters plan state with the default mode instead.
   */
  permissionMode?: string;
  /** Per-agent frontmatter hooks, scoped to this agent's session. */
  hooks?: Record<
    string,
    Array<{
      matcher?: string;
      hooks: Array<
        | {
            type: 'command';
            command: string;
            name?: string;
            timeout?: number;
            if?: string;
            shell?: string;
            statusMessage?: string;
            once?: boolean;
            async?: boolean;
            asyncRewake?: boolean;
            rewakeMessage?: string;
            rewakeSummary?: string;
          }
        | {
            type: 'http';
            url: string;
            name?: string;
            timeout?: number;
            headers?: Record<string, string>;
            if?: string;
            allowedEnvVars?: string[];
            statusMessage?: string;
            once?: boolean;
          }
        | {
            type: 'prompt';
            prompt: string;
            name?: string;
            timeout?: number;
            if?: string;
            model?: string;
            statusMessage?: string;
            once?: boolean;
          }
        | {
            type: 'agent';
            prompt: string;
            name?: string;
            timeout?: number;
            if?: string;
            model?: string;
            statusMessage?: string;
            once?: boolean;
          }
      >;
    }>
  >;
  /** Per-agent persistent memory scope ('user' or 'project'). */
  memory?: AgentMemoryScope;
  /** Whether this agent should always launch in the background. */
  background?: boolean;
  /** Raw isolation value. Loaders validate user input; plugin policy also filters this field. */
  isolation?: string;

  /**
   * An optional function to process the raw output from the agent's final tool
   * call into a string format.
   *
   * @param output The raw output value from the `complete_task` tool, now strongly typed with TOutput.
   * @returns A string representation of the final output.
   */
  processOutput?: (output: z.infer<TOutput>) => string;

  /**
   * Optional dynamic system prompt generator. When present, takes precedence
   * over `promptConfig.systemPrompt`. Receives runtime context (Config,
   * ToolRegistry) so the agent can inject dynamic content (skills, agents,
   * MCP servers, settings).
   */
  getSystemPrompt?: (context: {
    config: Config;
    toolRegistry: ToolRegistry;
  }) => string;

  /**
   * Optional preflight: returns why this agent cannot run against the given
   * child registry, or undefined when it can. The Agent tool uses it both for
   * availability listings and as the thrown message on dispatch, and
   * `agent-setup` re-checks it against the concrete child registry.
   *
   * Declared per definition so shared code never has to special-case an agent
   * by name. Only built-in definitions install one; a user-authored agent of
   * the same name has no hook and is therefore never preflight-refused.
   */
  checkAvailability?: (context: {
    toolRegistry: Pick<ToolRegistry, 'hasToolEnabled'>;
  }) => string | undefined;

  /**
   * Optional hook invoked before each model call. Receives the active
   * conversation history view.
   *
   * Runs immediately after chat compression in the agent loop.
   */
  onBeforeTurn?: (
    conversation: AgentConversationHistory,
    signal?: AbortSignal,
  ) => Promise<void> | void;
}

export type AgentDefinition<TOutput extends z.ZodTypeAny = z.ZodUnknown> =
  LocalAgentDefinition<TOutput>;

/**
 * Configures the initial prompt for the agent.
 */
export interface PromptConfig {
  /**
   * A single system prompt string. Supports templating using `${input_name}` syntax.
   */
  systemPrompt?: string;
  /**
   * An array of user/model content pairs for few-shot prompting.
   */
  initialMessages?: Content[];

  /**
   * The specific task or question to trigger the agent's execution loop.
   * This is sent as the first user message, distinct from the systemPrompt (identity/rules)
   * and initialMessages (history/few-shots). Supports templating.
   * If not provided, a generic "Get Started!" message is used.
   */
  query?: string;
}

/**
 * Configures the tools available to the agent during its execution.
 */
export interface ToolConfig {
  tools: Array<string | FunctionDeclaration | AnyDeclarativeTool>;
  /**
   * Whether the child keeps the unified Agent tool it inherits from its caller.
   *
   * Off by default: subagents must not recurse. Only the fork definition opts
   * in, because its tool schemas have to stay byte-identical to the parent's
   * for prompt-cache sharing (recursion is rejected at call time instead).
   */
  inheritAgentTool?: boolean;
}

/**
 * Configures the expected inputs (parameters) for the agent.
 */
export interface InputConfig {
  inputSchema: AnySchema;
}

/**
 * Configures the expected outputs for the agent.
 */
export interface OutputConfig<T extends z.ZodTypeAny> {
  /**
   * The name of the final result parameter. This will be the name of the
   * argument in the `submit_final_output` tool (e.g., "report", "answer").
   */
  outputName: string;
  /**
   * A description of the expected output. This will be used as the description
   * for the tool argument.
   */
  description: string;
  /**
   * Optional JSON schema for the output. If provided, it will be used as the
   * schema for the tool's argument, allowing for structured output enforcement.
   * Defaults to { type: 'string' }.
   */
  schema: T;
}

/**
 * Configures the execution environment and constraints for the agent.
 */
export interface RunConfig {
  /**
   * The maximum execution time for the agent in minutes.
   * If not specified, there is no time limit.
   */
  maxTimeMinutes?: number;
  /**
   * The maximum number of conversational turns.
   * Ordinary local Subagent execution defaults to 150 turns when omitted.
   */
  maxTurns?: number;
}
